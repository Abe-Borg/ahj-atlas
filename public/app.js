import { renderMarkdown } from './markdown.js';
import { createLatest } from './latest-refresh.js';
import { COUNTRIES, addressCountry, countryName } from './location.js';
const $=(selector,root=document)=>root.querySelector(selector);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=value=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:2}).format(value||0);
const date=value=>value?new Date(value).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'—';
const stageLabels={chat:'Project chat',jurisdiction:'Jurisdiction',contacts:'Contacts & process',codes:'Codes & standards',verification:'Opus evidence check',review:'Final report'};
const disciplines=['Architecture','Fire protection','Electrical','Mechanical','Plumbing','Structural','Civil'];
// Building use is Hyperscale data center (the default) or Other with the user's own use.
const buildingUses=['Hyperscale data center'];
const statuses={queued:'Queued',researching:'Researching',waiting_batch:'Batch queued',needs_key:'Needs API key',budget:'Paused',attention:'Needs attention',canceled:'Canceled',canceling:'Canceling',partial:'Needs confirmation',complete:'Research complete',failed:'Interrupted',waiting:'Waiting to retry'};
let state={bootstrap:null,projects:[],selected:null,detail:null,tab:'overview',action:null,formBusy:false}, timer;
let diagnosticsSnapshot=null,diagnosticsLoad=0,clientErrorCount=0,clientErrorWindow=Date.now();
let updateState=null;
const questionDrafts=new Map(),questionBusy=new Set();
const nameDrafts=new Map(),nameBusy=new Set(),nameErrors=new Map();
const chatDrafts=new Map(),chatOptions=new Map(),chatPending=new Set(),chatErrors=new Map(),chatRequests=new Map(),chatOlder=new Map();
// One new-project draft for this page, kept in memory like unsent chat and question
// drafts. Opening a saved project leaves it in place. New research restores it.
// Choosing New research again while that form is open asks before clearing it.
const projectDrafts=new Map();
function projectDraftFromForm(){
  const form=$('#project-form');if(!form)return null;
  return {
    address:$('#address').value,name:$('#name').value,
    discipline:$('#discipline').value,customDiscipline:$('#custom-discipline').value,
    scope:$('#scope').value,occupancy:$('#occupancy').value,customOccupancy:$('#custom-occupancy').value,
    permitDate:$('#permit-date').value,country:$('#country').value,countryChosen:$('#country').dataset.chosen==='1',
    siteDescription:$('#site-description').value,notes:$('#notes').value,
    mode:form.querySelector('[name=mode]:checked')?.value||'realtime',
    detailsOpen:Boolean($('details.extra',form)?.open),
  };
}
function projectDraftHasContent(draft){
  if(!draft)return false;
  const country=draft.country.trim();
  return Boolean(draft.address.trim()||draft.name.trim()||draft.discipline||(draft.occupancy&&draft.occupancy!==buildingUses[0])
    ||(draft.scope&&draft.scope!=='Not yet specified')||draft.permitDate||draft.siteDescription.trim()||draft.notes.trim()
    ||draft.mode==='batch'||(country&&country!=='United States'));
}
function captureNewProjectDraft(){
  const draft=projectDraftFromForm();if(!draft)return;
  if(projectDraftHasContent(draft))projectDrafts.set('new',draft);else projectDrafts.delete('new');
}
// The country follows the address until the user chooses one. A definite reading that
// disagrees with the user's choice is pointed out here; the server refuses it.
function syncCountry(address,select,note){
  if(!address||!select)return;
  const found=addressCountry(address.value);
  if(found&&select.dataset.chosen!=='1')select.value=found.country;
  if(note)note.textContent=found?.definite&&found.country!==select.value?`This address appears to be in ${found.country==='Canada'?'Canada':'the United States'}.`:'';
}
const syncProjectCountry=()=>syncCountry($('#address'),$('#country'),$('#country-note'));
// A country saved before the US/Canada choice stays selectable until it is changed.
function countryOptions(saved){
  const current=countryName(saved||'United States')||saved;
  return [...COUNTRIES,...(COUNTRIES.includes(current)?[]:[current])].map(c=>`<option ${c===current?'selected':''}>${esc(c)}</option>`).join('');
}
function syncBuildingUse(){
  const select=$('#occupancy');if(!select)return;
  const custom=select.value==='Other',input=$('#custom-occupancy'),field=$('#custom-occupancy-field'),label=$('#selected-building-use-value');
  if(field)field.hidden=!custom;
  if(input){input.disabled=!custom;input.required=custom;}
  if(label)label.textContent=custom?(input.value.trim()||'Other — enter building use'):select.value;
}
// Retry requests by project and declined turn. Each keeps its idempotency key, so a
// click after a lost response cannot create and charge for a second reply.
const chatRetries=new Map();
// Ask Atlas retries by project and question. The key matches a lost response to the
// same chat reply instead of starting and charging for a second one.
const atlasRequests=new Map();
// Proposal cards by project, turn and proposal: an Apply in progress, its error, and the chosen mode.
const proposalBusy=new Set(),proposalErrors=new Map(),proposalModes=new Map();
let projectLoad=0,detailGeneration=0;
// The project list is polled while research runs. The newest read is the one that paints,
// and an older caller waits for it instead of returning the list from before either request.
const projectLists=createLatest();
function recordClientError(message,location='',line=0){
  if(!state.bootstrap)return;if(Date.now()-clientErrorWindow>60000){clientErrorCount=0;clientErrorWindow=Date.now();}if(++clientErrorCount>10)return;
  fetch('/api/diagnostics/client',{method:'POST',headers:{'Content-Type':'application/json','X-App-Token':state.bootstrap.token},body:JSON.stringify({message:String(message||'Browser error').slice(0,2000),location:String(location).slice(0,300),line,projectId:state.selected})}).catch(()=>{});
}
window.addEventListener('error',e=>recordClientError(e.message,e.filename,e.lineno));
window.addEventListener('unhandledrejection',e=>recordClientError(e.reason?.message||'An asynchronous browser operation failed.'));
async function api(url,options={}){
  let response;try{response=await fetch(url,{...options,headers:{'Content-Type':'application/json',...(state.bootstrap?{'X-App-Token':state.bootstrap.token}:{}),...options.headers},body:options.body===undefined?undefined:JSON.stringify(options.body)});}catch(e){recordClientError('The browser could not reach the local application.',url);throw e;}
  const data=await response.json();if(!response.ok)throw new Error(data.error||'The request could not be completed.');return data;
}
function toast(text){$('#toast').textContent=text;$('#toast').hidden=false;clearTimeout(timer);timer=setTimeout(()=>$('#toast').hidden=true,5000);}
const updateReady=u=>Boolean(u?.updateAvailable&&u.download?.state==='ready'&&u.download.version===u.latestVersion);
function renderUpdateStatus(){
  if(!state.bootstrap?.updatesEnabled)return;
  const u=updateState,current=u?.currentVersion||state.bootstrap.version,available=Boolean(u?.updateAvailable&&u.releaseUrl),inApp=Boolean(u?.canInstall),d=u?.download||{};
  const percent=d.totalBytes?Math.min(100,Math.floor(d.receivedBytes/d.totalBytes*100)):null;
  const unfinished=u?.notice?.type==='failed'?`The update to ${u.notice.version} did not finish. `:'';
  let text='',action='';
  if(u?.installing)text=`Installing AHJ Atlas ${d.version||u.latestVersion}. The app will close and reopen when the update finishes.`;
  else if(inApp&&d.state==='downloading'){text=`Downloading AHJ Atlas ${d.version||u.latestVersion}…${percent==null?'':` ${percent}%`}`;action='Downloading…';}
  else if(updateReady(u)){text=`${unfinished}AHJ Atlas ${u.latestVersion} is downloaded and verified. Restart to install it; the app reopens and your projects are kept.`;action='Restart and install';}
  else if(available&&inApp&&d.state==='failed'){text=`The update download did not finish. ${d.error}`;action='Try again';}
  else if(available&&inApp){text=`${unfinished}AHJ Atlas ${u.latestVersion} is available. You have ${current}.`;action='Download update';}
  else if(available)text=`AHJ Atlas ${u.latestVersion} is available. You have ${current}.`;
  $('#update-settings').hidden=false;
  $('#update-banner').hidden=!text;
  $('#update-banner-text').textContent=text;
  for(const id of ['#update-banner-action','#update-action']){const button=$(id);button.hidden=!action;button.textContent=action;button.disabled=d.state==='downloading'||Boolean(u?.installing);}
  $('#update-banner-link').hidden=!available;$('#update-release-link').hidden=!available;
  if(available){
    $('#update-banner-link').textContent=inApp?'What’s new ↗':'View release and install ↗';
    $('#update-banner-link').href=u.releaseUrl;
    $('#update-release-link').href=u.releaseUrl;
  }
  const checked=u?.checkedAt?` Last checked ${date(u.checkedAt)}.`:'';
  $('#update-status').textContent=u?.error&&!available?`${u.error}${checked}`
    :text?`${text}${available&&!inApp?' Download the installer and checksum from the release page.':''}${checked}`
    :u?.latestVersion?`Version ${current} is up to date.${checked}`
    :u?.checkedAt?`No published Windows release is available yet.${checked}`:`Installed version ${current}. No update check has completed yet.`;
}
let updatePoll=null;
function followUpdate(){
  clearTimeout(updatePoll);
  if(updateState?.download?.state!=='downloading')return;
  updatePoll=setTimeout(async()=>{try{updateState=await api('/api/updates');renderUpdateStatus();}catch{}followUpdate();},1000);
}
async function checkUpdates(force=false){
  if(!state.bootstrap?.updatesEnabled)return;
  const button=$('#check-updates');
  if(force){button.disabled=true;button.textContent='Checking…';}
  try{
    updateState=await api('/api/updates',force?{method:'POST',body:{}}:{});renderUpdateStatus();followUpdate();
    if(updateState.notice?.type==='updated'&&!state.updateNoticeShown){state.updateNoticeShown=true;toast(`AHJ Atlas was updated to ${updateState.notice.version}.`);}
  }
  catch(error){$('#update-status').textContent=`Could not check for updates: ${error.message}`;}
  finally{if(force){button.disabled=false;button.textContent='Check for updates';}}
}
// Download verifies the installer's published checksum; install closes the app, runs the installer and reopens.
async function runUpdateAction(){
  try{
    updateState=await api(updateReady(updateState)?'/api/updates/install':'/api/updates/download',{method:'POST',body:{}});
    renderUpdateStatus();followUpdate();
  }catch(error){toast(error.message);}
}
$('#check-updates').addEventListener('click',()=>checkUpdates(true));
for(const id of ['#update-banner-action','#update-action'])$(id).addEventListener('click',runUpdateAction);
async function loadDiagnostics(){
  const load=++diagnosticsLoad;diagnosticsSnapshot=null;$('#download-diagnostics').disabled=true;$('#diagnostic-content').innerHTML='<p class="muted" style="margin-top:20px">Loading saved records…</p>';
  try{
    const report=await api('/api/diagnostics',{method:'POST',body:{projectId:$('#diagnostic-project').value||null}});if(load!==diagnosticsLoad)return;diagnosticsSnapshot=report;
    const attempts=report.projects.flatMap(p=>p.attempts.map(a=>({...a,projectId:p.id}))).sort((a,b)=>b.created.localeCompare(a.created));
    const failed=attempts.filter(a=>['errored','unknown'].includes(a.state)),events=report.events.slice(0,80);
    const starvation=report.starvation||{},hostEpisodes=Object.values(starvation.host?.episodes||{}).reduce((a,b)=>a+b,0),throttled=starvation.provider?.throttledRequests||0,active=report.application.resources?.active||[];
    $('#diagnostic-content').innerHTML=`<div class="diagnostic-summary"><div><small>APP VERSION</small><strong>${esc(report.application.version)}</strong></div><div><small>REQUESTS RECORDED</small><strong>${attempts.length}</strong></div><div><small>FAILED / UNCERTAIN</small><strong>${failed.length}</strong></div><div><small>STARVED / THROTTLED</small><strong>${hostEpisodes} / ${throttled}</strong></div></div><p class="field-help">Snapshot ${esc(date(report.generatedAt))}. Errors below may be historical and already resolved.</p>${report.projects.filter(p=>['attention','budget','needs_key','failed'].includes(p.status)).map(p=>`<div class="notice"><strong>${esc(statuses[p.status]||p.status)}</strong><p>${esc(p.note||'Review the request history for this project.')}</p></div>`).join('')}<details class="diagnostic-section" open><summary>Progress and recovery</summary>${report.projects.map(p=>`<div class="diagnostic-project"><p class="field-help">Project ${esc(p.id.slice(0,8))} · ${esc(statuses[p.status]||p.status)} · ${esc(money(p.cost))} recorded · ${p.sourceCount} sources${p.starvation?.host?.timedRowsStarved?` · ${p.starvation.host.timedRowsStarved} operations while starved`:''}${p.starvation?.provider?.throttledRequests?` · ${p.starvation.provider.throttledRequests} throttled`:''}</p><div class="diagnostic-stages">${p.stages.map(s=>`<div><strong>${esc(stageLabels[s.id]||s.id)}</strong><span>${esc(s.status)} · ${s.rounds} requests</span></div>`).join('')}</div></div>`).join('')||'<p>No projects yet.</p>'}</details><details class="diagnostic-section"><summary>Resources and starvation</summary><p class="field-help">${active.length?'The computer is starving the app now: '+esc(active.join(', '))+'.':'No host starvation is active now.'} Host episodes count event-loop stalls, pauses, a fully busy CPU, a nearly full heap and exhausted system memory. Throttled requests are Anthropic rate limits and overloads. Allowances are the app’s own research limits.</p><pre>${esc(JSON.stringify({starvation:report.starvation,host:report.application.resources},null,2))}</pre></details><details class="diagnostic-section"><summary>Request history (${attempts.length})</summary><p class="field-help">Showing the latest 30. The download includes every saved request summary.</p>${attempts.slice(0,30).map(a=>`<details class="diagnostic-entry"><summary>${esc(stageLabels[a.stage]||a.stage)} · ${esc(a.state)} · ${esc(date(a.created))}</summary><pre>${esc(JSON.stringify(a,null,2))}</pre></details>`).join('')||'<p>No requests recorded.</p>'}</details><details class="diagnostic-section" open><summary>Detailed events (${report.events.length})</summary><p class="field-help">Showing the latest 80. Up to ${report.retention.maximumEvents.toLocaleString()} events are retained locally across the workspace.</p>${events.map(e=>`<details class="diagnostic-entry"><summary><span class="status-pill ${e.level==='error'?'red':e.level==='warning'?'amber':''}">${esc(e.level)}</span> ${esc(e.event)} <span class="field-help">${esc(date(e.time))}</span></summary><pre>${esc(JSON.stringify({time:e.time,projectId:e.project_id,stage:e.stage_id,attemptId:e.attempt_id,...e.details},null,2))}</pre></details>`).join('')||'<p>Detailed tracing begins with this update. Historical request summaries remain available above.</p>'}</details><p class="field-help">${esc(report.retention.note)}</p>`;
    $('#download-diagnostics').disabled=false;
  }catch(e){if(load===diagnosticsLoad)$('#diagnostic-content').innerHTML=`<div class="inline-error" role="alert">${esc(e.message)}</div>`;}
}
$('#open-diagnostics').addEventListener('click',()=>{ $('#settings-dialog').close();$('#diagnostic-project').innerHTML='<option value="">Entire workspace</option>'+state.projects.map(p=>`<option value="${esc(p.id)}" ${p.id===state.selected?'selected':''}>${esc(p.name)}</option>`).join('');$('#diagnostics-dialog').showModal();loadDiagnostics();});
$('#diagnostic-project').addEventListener('change',loadDiagnostics);
$('#refresh-diagnostics').addEventListener('click',loadDiagnostics);
$('#download-diagnostics').addEventListener('click',()=>{if(!diagnosticsSnapshot)return;const a=document.createElement('a');a.href='/api/diagnostics/download'+($('#diagnostic-project').value?'?project='+encodeURIComponent($('#diagnostic-project').value):'');a.download='AHJ-Atlas-diagnostics.json';document.body.appendChild(a);a.click();a.remove();});
const icons={pin:'<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z"/><circle cx="12" cy="10" r="2.5"/></svg>',people:'<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M17 5a3 3 0 0 1 0 6m1 3a5 5 0 0 1 3 5v2"/></svg>',book:'<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 4h14a2 2 0 0 1 2 2v15H6a2 2 0 0 1-2-2V4Zm0 13h16M8 8h8M8 11h6"/></svg>',check:'<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/></svg>'};
function newForm({keepDraft=true}={}){
  if(keepDraft)captureNewProjectDraft();
  const prefill=keepDraft?(projectDrafts.get('new')||{}):{};
  projectLoad++;
  const custom=prefill.discipline==='Other',country=COUNTRIES.includes(prefill.country)?prefill.country:'United States';
  const customUse=prefill.occupancy==='Other';
  const use=buildingUses.includes(prefill.occupancy)?prefill.occupancy:buildingUses[0];
  const selectedUse=customUse?(String(prefill.customOccupancy||'').trim()||'Other — enter building use'):use;
  const detailsOpen=customUse||(prefill.detailsOpen!=null?Boolean(prefill.detailsOpen):Boolean(prefill.notes||prefill.siteDescription));
  state.selected=null;state.detail=null;state.tab='overview';history.replaceState(null,'','/');renderSidebar();$('#breadcrumb').innerHTML='WORKSPACE <span>/</span> NEW RESEARCH';
  $('#main').innerHTML=`<div class="intro"><div><span class="eyebrow">A BETTER START TO DESIGN</span><h1>Know your jurisdiction.</h1><p>Find the authorities, people, and adopted codes that matter to your project.</p></div><span class="intro-badge">Built for engineers & architects</span></div>
  <div class="new-grid"><form id="project-form" class="panel"><div class="panel-padding"><div class="panel-head"><span class="step-number">01</span><h2>Your project</h2></div>
  <div class="form-row address-row stack-small"><div class="field"><label for="address">Project address</label><input id="address" name="address" required minlength="8" maxlength="500" autocomplete="street-address" placeholder="Street address, city, state or province, ZIP or postal code" value="${esc(prefill.address||'')}"><p class="field-help">A complete address helps distinguish municipal, county or regional, and special-district authority.</p></div><div class="field"><label for="country">Country</label><select id="country" name="country" required ${prefill.countryChosen?'data-chosen="1"':''}>${COUNTRIES.map(c=>`<option ${country===c?'selected':''}>${c}</option>`).join('')}</select><p class="field-help country-note" id="country-note" aria-live="polite"></p></div></div>
  <div class="form-row"><div class="field"><label for="discipline">Your discipline</label><select name="discipline" id="discipline" required><option value="">Select your discipline</option>${disciplines.map(d=>`<option ${prefill.discipline===d?'selected':''}>${d}</option>`).join('')}<option value="Other" ${custom?'selected':''}>Other — enter your discipline</option></select><div class="field" id="custom-discipline-field" ${custom?'':'hidden'} style="margin-top:14px"><label for="custom-discipline">Your discipline or specialty</label><input id="custom-discipline" name="customDiscipline" minlength="2" maxlength="100" placeholder="e.g. Acoustics, telecommunications" value="${esc(custom?(prefill.customDiscipline||''):'')}" ${custom?'required':'disabled'}><p class="field-help">Research will follow the discipline you enter.</p></div></div><div class="field"><label for="name">Project name</label><input id="name" name="name" required maxlength="100" placeholder="e.g. Westside renovation" value="${esc(prefill.name||'')}"></div></div>
  <p class="selected-use" id="selected-building-use">Building use: <strong id="selected-building-use-value">${esc(selectedUse)}</strong> <span class="field-help">Included in the research brief. Change it under Add project context.</span></p>
  <details class="extra" ${detailsOpen?'open':''}><summary>Add project context <span class="optional">optional</span></summary><div class="form-row"><div class="field"><label for="scope">Scope of work <span class="optional">optional</span></label><select name="scope" id="scope">${['Not yet specified','New construction','Renovation / alteration','Addition','Tenant improvement','Change of occupancy','Existing building assessment'].map(s=>`<option ${prefill.scope===s?'selected':''}>${s}</option>`).join('')}</select></div><div class="field"><label for="occupancy">Building use</label><select name="occupancy" id="occupancy">${buildingUses.map(u=>`<option ${!customUse&&use===u?'selected':''}>${u}</option>`).join('')}<option value="Other" ${customUse?'selected':''}>Other — enter building use</option></select><div class="field" id="custom-occupancy-field" ${customUse?'':'hidden'} style="margin-top:14px"><label for="custom-occupancy">Your building use</label><input id="custom-occupancy" name="customOccupancy" minlength="2" maxlength="100" placeholder="e.g. Cold storage, aircraft hangar" value="${esc(customUse?(prefill.customOccupancy||''):'')}" ${customUse?'required':'disabled'}></div></div></div><div class="form-row"><div class="field"><label for="permit-date">Expected permit date <span class="optional">optional</span></label><input type="date" name="permitDate" id="permit-date" value="${esc(prefill.permitDate||'')}"></div></div><div class="field"><label for="site-description">Parcel number or site description <span class="optional">optional</span></label><input id="site-description" name="siteDescription" maxlength="500" placeholder="APN, PID, roll or lot number, legal land description, or site location when no street address is assigned" value="${esc(prefill.siteDescription||'')}"><p class="field-help">Helps locate new-tract or unaddressed sites. You can correct the address or this description later when you continue research.</p></div><label for="notes">Additional context <span class="optional">optional</span></label><textarea id="notes" name="notes" rows="3" maxlength="4000" placeholder="Known AHJ, proposed systems (sprinklers, pumps, batteries, generators, fuel), equipment quantities, and owner/insurer requirements">${esc(prefill.notes||'')}</textarea></details>
  <div class="section-divider"></div><div class="panel-head"><span class="step-number">02</span><h2>How would you like to research?</h2></div><div class="mode-choices"><label class="mode-choice"><span class="mode-title"><input type="radio" name="mode" value="realtime" ${prefill.mode!=='batch'?'checked':''}> Research now</span><p>Start immediately.<br>Follow progress as it happens.</p></label><label class="mode-choice"><span class="mode-title"><input type="radio" name="mode" value="batch" ${prefill.mode==='batch'?'checked':''}> Research later</span><p>Queue your research.<br>Receive results by stage.</p><span class="saving">50% lower model token prices</span></label></div><p class="field-help" id="mode-help">Both modes use the same evidence checks. Search fees are unchanged.</p><p class="field-help">Estimated costs appear on the project as research runs. Your Anthropic invoice is authoritative.</p><div class="inline-error" role="alert" id="project-error"></div></div><div class="form-bottom"><p>Every report includes sources<br>and questions still to resolve.</p><button class="button primary" type="submit" id="start-research">Start research <span aria-hidden="true">↗</span></button></div></form>
  <aside><div class="panel coverage"><div class="coverage-title">YOUR RESEARCH BRIEF</div>${[['pin','The right authorities','Building, planning, fire, and other agencies with authority over your address.'],['people','People you can contact','Publicly listed contacts, their responsibilities, and how to reach them.'],['book','The editions that apply','Adopted codes, referenced standards, effective dates, and local amendments.'],['check','Evidence you can inspect','Original sources, supporting passages, and clear gaps to confirm with the AHJ.']].map(([icon,title,text])=>`<div class="coverage-item"><span class="coverage-icon">${icons[icon]}</span><div><h3>${title}</h3><p>${text}</p></div></div>`).join('')}</div><div class="evidence-note"><h3>Published doesn’t always mean adopted.</h3><p>The research traces local adoption documents and referenced editions. Unconfirmed requirements stay visible as questions to resolve.</p></div><p class="settings-hint">${state.bootstrap?.keyConfigured?'Your Claude connection is ready.':'Bring your own Claude API key. <button type="button" id="connect-hint">Connect your account</button> to begin.'}</p></aside></div>`;
  $('#project-form').addEventListener('submit',startProject);
  $('#address').addEventListener('input',syncProjectCountry);
  $('#country').addEventListener('change',()=>{$('#country').dataset.chosen='1';syncProjectCountry();});
  syncProjectCountry();
  $('#project-form').addEventListener('input',()=>{syncBuildingUse();captureNewProjectDraft();});
  $('#project-form').addEventListener('change',()=>{syncBuildingUse();captureNewProjectDraft();});
  $('details.extra').addEventListener('toggle',captureNewProjectDraft);
  $('#discipline').addEventListener('change',()=>{const custom=$('#discipline').value==='Other';$('#custom-discipline-field').hidden=!custom;$('#custom-discipline').disabled=!custom;$('#custom-discipline').required=custom;if(custom)$('#custom-discipline').focus();});
  $('#occupancy').addEventListener('change',()=>{syncBuildingUse();if($('#occupancy').value==='Other')$('#custom-occupancy').focus();});
  $('#connect-hint')?.addEventListener('click',openSettings);
  for(const radio of document.querySelectorAll('[name=mode]'))radio.addEventListener('change',()=>{$('#mode-help').textContent=radio.value==='batch'?'Batch stages can each take up to 24 hours; a multi-stage report can take longer. Search fees are unchanged.':'Both modes use the same evidence checks. Search fees are unchanged.';});
}
function renderSidebar(){
  $('#project-count').textContent=state.projects.length;
  $('#project-list').innerHTML=state.projects.length?state.projects.map(p=>`<button class="project-nav ${state.selected===p.id?'active':''}" data-project="${esc(p.id)}"><strong>${esc(p.name)}</strong><small>${esc(p.discipline)} · ${esc(statuses[p.status]||p.status)}</small></button>`).join(''):'<p class="sidebar-empty">Your projects will appear here.</p>';
  for(const b of document.querySelectorAll('[data-project]'))b.addEventListener('click',()=>selectProject(b.dataset.project));
  const view=connectionView(),button=$('#open-settings');$('#connection-label').textContent=view.label;button.title=view.title;button.dataset.status=view.status;
  const light=$('.connection-light');light.classList.toggle('on',view.status==='connected');light.classList.toggle('off',['missing','invalid'].includes(view.status));light.classList.toggle('pending',['checking','unavailable'].includes(view.status));
}
function connectionView(){
  const b=state.bootstrap,status=b?.keyStatus||(b?.keyConfigured?'checking':'missing');
  return {status,...({
    connected:{label:'Claude connected',title:'Anthropic accepted your API key.'},
    checking:{label:'Checking Claude…',title:'Checking your saved API key with Anthropic.'},
    unavailable:{label:'Claude unavailable',title:b?.keyMessage||'Anthropic could not be reached to check your API key. It will be checked again automatically.'},
    invalid:{label:'Claude disconnected',title:b?.keyMessage||'Anthropic did not accept your API key. Enter a new key to reconnect.'},
    missing:{label:'Claude disconnected',title:'No API key is connected. Enter your Anthropic API key to connect.'},
  }[status]||{label:'Claude disconnected',title:'Enter your Anthropic API key to connect.'})};
}
let connectionChecked=0,connectionRetryMs=60000;
async function refreshConnection(verify=false){
  // A saved key that could not be checked (network failure or a temporary Anthropic error) is retried quietly, backing off from 1 to 15 minutes.
  const retry=verify||state.bootstrap.keyStatus==='unavailable'&&Date.now()-connectionChecked>connectionRetryMs;
  if(retry)connectionChecked=Date.now();
  const next=retry?await api('/api/connection/check',{method:'POST',body:{}}):await api('/api/connection');
  if(next.keyStatus!=='unavailable')connectionRetryMs=60000;else if(retry&&!verify)connectionRetryMs=Math.min(connectionRetryMs*2,15*60000);
  const changed=['keyConfigured','keyStatus','keyMessage','persisted'].some(k=>next[k]!==state.bootstrap[k]);Object.assign(state.bootstrap,next);
  if(changed){renderSidebar();if($('#settings-dialog').open)renderConnectionNote();}
}
function renderConnectionNote(){
  const note=$('#connection-note'),view=connectionView(),show=['invalid','unavailable'].includes(view.status);
  note.hidden=!show;note.textContent=show?view.title:'';note.classList.toggle('error',view.status==='invalid');
  $('#api-key').placeholder=({connected:'Connected · enter a key to replace it',checking:'Checking saved key · enter a key to replace it',unavailable:'Saved key not yet verified · enter a key to replace it',invalid:'Key not accepted · enter a new key'})[view.status]||'sk-ant-…';
}
async function startProject(e){e.preventDefault();if(['missing','invalid'].includes(connectionView().status)){openSettings();return;}const button=$('#start-research');button.disabled=true;button.textContent='Creating project…';try{const body=Object.fromEntries(new FormData(e.target));if(body.discipline==='Other'){body.discipline=body.customDiscipline.trim();}delete body.customDiscipline;const p=await api('/api/projects',{method:'POST',body});projectDrafts.delete('new');await refreshProjects();await selectProject(p.id,{capture:false});}catch(error){if($('#project-error'))$('#project-error').textContent=error.message;}finally{if(button.isConnected){button.disabled=false;button.innerHTML='Start research <span aria-hidden="true">↗</span>';}}}
async function refreshProjects(){await projectLists.run(async isCurrent=>{const projects=await api('/api/projects');if(!isCurrent())return;state.projects=projects;renderSidebar();});}
function applySavedProject(project){
  projectLists.invalidate();detailGeneration++;
  const index=state.projects.findIndex(item=>item.id===project.id);
  if(index>=0)state.projects[index]=project;
  if(state.detail?.project.id===project.id)state.detail.project=project;
  renderSidebar();
  const option=$('#diagnostic-project')?.querySelector(`option[value="${CSS.escape(project.id)}"]`);
  if(option)option.textContent=project.name;
}
async function selectProject(id,{capture=true}={}){if(capture)captureNewProjectDraft();const load=++projectLoad;state.selected=id;state.detail=null;state.tab=state.tab==='chat'?'chat':'overview';history.replaceState(null,'',`/#project=${encodeURIComponent(id)}`);renderSidebar();$('#main').innerHTML='<div class="loading">Opening project…</div>';try{const detail=await api(`/api/projects/${id}`);if(load!==projectLoad||state.selected!==id)return;state.detail=detail;renderProject();}catch(e){if(load===projectLoad)$('#main').innerHTML=`<div class="error-panel">${esc(e.message)}</div>`;}}
function statusClass(status){return ['complete','verified'].includes(status)?'green':['partial','budget','attention','conflicting','inferred','unverified','needs_key'].includes(status)?'amber':['failed','canceled'].includes(status)?'red':'';}
function badge(status){return `<span class="status-pill ${statusClass(status)}">${esc(({verified:'Source-supported',inferred:'Conditional',conflicting:'Conflicting',unverified:'Unconfirmed'})[status]||statuses[status]||status)}</span>`;}
function href(url){try{const u=new URL(url);return ['http:','https:'].includes(u.protocol)?u.href:'';}catch{return '';}}
function link(url,label){const safe=href(url);return safe?`<a href="${esc(safe)}" target="_blank" rel="noopener noreferrer">${esc(label||url)} ↗</a>`:'';}
function evidenceList(item){return item.evidence?.length?`<ul class="evidence-list">${item.evidence.map(e=>`<li><button class="banner-link" data-source="${esc(e.sourceId)}">${esc(e.sourceId)}${e.pageOrSection?' · '+esc(e.pageOrSection):''}</button>${e.supported?'':' · Supporting passage needs confirmation'}${e.quote?`<q>${esc(e.quote)}</q>`:''}</li>`).join('')}</ul>`:'';}
function empty(title,description){return `<div class="empty-state"><h3>${esc(title)}</h3><p>${esc(description)}</p></div>`;}
function questionForm(g){
  const key=state.selected+':'+g.id,busy=questionBusy.has(key),answer=questionDrafts.get(key)??g.answer??'';
  return `<form data-question-form="${esc(g.id)}"><label for="answer-${g.id}">Your answer</label><textarea id="answer-${g.id}" name="answer" rows="3" maxlength="4000" required placeholder="Share what you know about this project…" ${busy?'disabled':''}>${esc(answer)}</textarea><div class="question-actions"><button class="button primary" type="submit" ${busy?'disabled':''}>${busy?'Saving…':'Save answer'}</button>${g.status==='open'?`<button class="button secondary" type="button" data-question-action="dismissed" ${busy?'disabled':''}>Dismiss</button>`:''}</div></form>`;
}
function askAtlasButton(){
  const chatBusy=chatPending.has(state.selected)||Boolean(state.detail?.chat?.active);
  return `<div class="question-actions"><button class="button secondary" type="button" data-ask-atlas ${chatBusy?'disabled':''}>Ask Atlas</button></div>`;
}
function questionReason(g){return g.reason?`<p class="field-help">Reason: ${esc(g.reason)}</p>`:'';}
function gapCards(gaps){return gaps.map(g=>{
  const busy=questionBusy.has(state.selected+':'+g.id),label={answered:'Answered',dismissed:'Dismissed',closed:'Closed'}[g.status]||'';
  const body=g.status==='open'?`<p>${esc(g.nextStep)}</p>${g.contact?`<p class="field-help">Contact: ${esc(g.contact)}</p>`:''}${questionForm(g)}`:g.status==='answered'?`<p class="question-answer">${esc(g.answer)}</p><p class="field-help">User-provided answer</p>${questionReason(g)}<details id="edit-${g.id}" class="question-edit"><summary>Edit answer</summary>${questionForm(g)}</details>`:g.status==='closed'?`${questionReason(g)||'<p class="field-help">A later research report no longer includes this question.</p>'}`:`<p class="field-help">Set aside by you. You can reopen it at any time.</p>${questionReason(g)}`;
  return `<article class="finding-card question-card" data-question="${esc(g.id)}"><div class="finding-top"><h3>${esc(g.question)}</h3>${label?`<span class="status-pill ${g.status==='answered'?'green':''}">${label}</span>`:''}</div><p class="muted">${esc(g.why)}</p>${body}${g.status==='open'?'':`<button class="text-button" type="button" data-question-action="open" ${busy?'disabled':''}>Reopen question</button>`}${askAtlasButton()}<div class="inline-error" role="alert" data-question-error></div></article>`;
}).join('');}
function questionsView(p){
  const questions=p.questions||[],open=questions.filter(g=>g.status==='open'),saved=questions.filter(g=>g.status!=='open');
  const canResearch=!['queued','researching','waiting_batch','waiting','canceling','needs_key'].includes(p.status)&&!state.detail.attempts.some(a=>['dispatching','pending','received','unknown'].includes(a.state));
  return `<section class="report-section" id="project-questions"><div class="finding-top"><h2>Questions to resolve</h2><span class="status-pill amber" aria-label="${open.length} open questions">${open.length}</span></div><p class="field-help question-help">Save what you know, dismiss a question that is not a priority, or choose Ask Atlas to resolve it in Chat with Atlas. Answers you save stay on this project and do not start research.</p>${p.questionResponses?.length?`<div class="question-research"><p class="field-help">${p.questionUpdatesPending?'Your updates are saved. Start a new research round to check their implications.':'Your saved answers and dismissals are included in the latest research context.'}</p>${canResearch?'<button class="button secondary" id="research-answers">Research with saved answers</button>':'<p class="field-help">You can start another round when the current research and outstanding requests have settled.</p>'}</div>`:''}${open.length?gapCards(open):empty(questions.length?'No open questions':'No additional questions identified',questions.length?'Your answered, dismissed, and closed questions are saved below.':'Review the source evidence with your project team before using it for design.')}${saved.length?`<details id="saved-questions" class="saved-questions"><summary>Answered, dismissed & closed <span class="tab-count">${saved.length}</span></summary>${gapCards(saved)}</details>`:''}</section>`;
}
async function saveQuestion(card,status){
  const id=state.selected,questionId=card.dataset.question,key=id+':'+questionId;
  if(questionBusy.has(key))return;
  const answer=card.querySelector('textarea')?.value||'';
  questionBusy.add(key);card.querySelectorAll('button').forEach(b=>b.disabled=true);$('[data-question-error]',card).textContent='';
  try{
    await api(`/api/projects/${id}/questions`,{method:'POST',body:{questionId,status,answer}});
    questionDrafts.delete(key);questionBusy.delete(key);
    if(state.selected===id)await refreshSelected();
    toast(status==='answered'?'Answer saved.':status==='dismissed'?'Question dismissed. You can reopen it below.':'Question reopened.');
  }catch(e){
    const current=state.selected===id?document.querySelector(`[data-question="${questionId}"]`):null;
    if(current)$('[data-question-error]',current).textContent=e.message;
  }finally{questionBusy.delete(key);if(state.selected===id)document.querySelector(`[data-question="${questionId}"]`)?.querySelectorAll('button,textarea').forEach(b=>b.disabled=false);}
}
// Notes the user saved from project chat; their citations open the saved sources.
function notesView(detail){
  const notes=detail.notes||[];if(!notes.length)return '';
  return `<section class="report-section" id="report-notes"><h2>Notes</h2><p class="field-help">Saved from project chat by you. They record what that conversation concluded, with its citations, and were not re-verified by research.</p>${notes.map(n=>`<article class="finding-card report-note"><div class="finding-top"><h3>${esc(n.title)}</h3><button type="button" class="text-button" data-delete-note="${esc(n.id)}" aria-label="Remove the note ${esc(n.title)}">Remove</button></div><div class="chat-prose">${chatText(n.text)}</div><p class="field-help">Saved ${esc(date(n.created))}</p></article>`).join('')}</section>`;
}
function overview(detail){
  const {project:p,stages,sources}=detail,r=p.report;
  if(!r)return `<div class="report-grid"><section><h2>Research in progress</h2>${stages.some(s=>s.output)?stages.filter(s=>s.output).map(s=>`<article class="finding-card"><div class="finding-top"><h3>${esc(stageLabels[s.id]||s.id)}</h3>${badge(s.status)}</div><p class="field-help">Working findings · final evidence review pending</p><details><summary>Read the working brief</summary><div class="prose">${esc(s.output)}</div></details>${s.note?`<p class="field-help">${esc(s.note)}</p>`:''}</article>`).join(''):empty('Building your evidence base','The research begins with your address and responsible authorities. Source-linked findings will appear here as each stage finishes.')}${notesView(detail)}<div class="project-note">${p.mode==='batch'?'Each batch stage can take up to 24 hours; a report with dependent stages can take longer. Keep the local app running to advance stages automatically.':'Estimated costs update as each request finishes. If a source is unavailable, the report will explain what still needs confirmation.'}</div></section><aside class="panel panel-padding"><span class="eyebrow">PROJECT CONTEXT</span><h3>${esc(p.discipline)}</h3><p class="muted">${esc(p.input.scope||'Scope not specified')}<br>${esc(p.input.occupancy||'Building use not specified')}</p><p class="field-help">Expected permit date: ${esc(p.input.permitDate||'Not specified')}</p>${p.input.notes?`<p class="prose">${esc(p.input.notes)}</p>`:''}<div class="section-divider"></div><h3>Sources collected</h3><p class="muted">${sources.filter(s=>s.read_full).length} read as evidence · ${sources.filter(s=>!s.read_full).length} discovered or visually inspected</p><button class="text-button" data-tab="sources">Inspect the source register →</button></aside></div>`;
  return `<div class="report-grid"><div><section class="panel panel-padding report-section"><span class="eyebrow">PROJECT BRIEFING</span><p class="prose">${esc(r.summary)}</p>${r.researchHealth?.incompleteStages?.length?`<p class="project-note">Some research is unfinished: ${esc(r.researchHealth.incompleteStages.map(s=>stageLabels[s.stage]||s.stage).join(", "))}. See the saved working briefs and questions to resolve.</p>`:""}</section>${notesView(detail)}<section class="report-section"><div class="finding-card"><div class="finding-top"><h2>Jurisdiction</h2>${badge(r.jurisdiction.status)}</div><h3>${esc(r.jurisdiction.authority)}</h3><p class="prose">${esc(r.jurisdiction.description)}</p>${r.jurisdiction.notes?`<p class="muted">${esc(r.jurisdiction.notes)}</p>`:''}${evidenceList(r.jurisdiction)}</div></section><section class="report-section"><h2>Reviewing authorities</h2>${r.authorities.length?r.authorities.map(a=>`<article class="finding-card"><div class="finding-top"><h3>${esc(a.name)}</h3>${badge(a.status)}</div><p>${esc(a.responsibility)}</p><p class="muted">${esc([a.phone,a.email,a.address].filter(Boolean).join(' · '))}</p>${link(a.website,'Official website')}${evidenceList(a)}</article>`).join(''):empty('Authorities not confirmed','See questions to resolve before relying on jurisdiction findings.')}</section><section class="report-section"><h2>Permits & submission requirements</h2>${r.requirements.length?r.requirements.map(q=>`<article class="finding-card"><div class="finding-top"><h3>${esc(q.title)}</h3>${badge(q.status)}</div><p class="field-help">${esc(q.authority)}</p><p class="prose">${esc(q.details)}</p>${link(q.website,'Submission resource')}${evidenceList(q)}</article>`).join(''):empty('No submission requirements verified','Check directly with the responsible authority for the current submission process.')}</section></div><aside>${questionsView(p)}<section class="panel panel-padding"><span class="eyebrow">RESEARCH COVERAGE</span>${Object.entries(r.coverage||{}).map(([k,v])=>`<h3>${esc(({jurisdiction:'Jurisdiction',contacts:'Contacts',codes:'Codes & standards',process:'Submission process'})[k]||k)}</h3><p class="field-help">${esc(v)}</p>`).join('')}</section></aside></div><p class="project-note">${esc(r.disclaimer)}</p>`;
}
function contactsView(r){if(!r)return empty('Contacts are being researched','Verified professional contacts will be organized here after the evidence review. Working briefs are available in Overview.');if(!r.contacts.length)return empty('No individual contacts confirmed','Use the responsible offices listed in Overview. Unpublished names and email addresses are not guessed.');return `<div class="contact-grid">${r.contacts.map(c=>`<article class="finding-card"><div class="finding-top"><div><span class="eyebrow">${esc(c.organization)}</span><h2>${esc(c.name||'Department contact')}</h2><p class="muted">${esc(c.title)}</p></div>${badge(c.status)}</div><p>${esc(c.responsibility)}</p><div class="contact-links">${c.email&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email)?`<a href="mailto:${esc(encodeURIComponent(c.email))}">${esc(c.email)}</a>`:''}${c.phone?`<a href="tel:${esc(c.phone.replace(/[^+\d]/g,''))}">${esc(c.phone)}</a>`:''}${link(c.website,'Website')}</div>${c.address?`<p class="field-help">${esc(c.address)}</p>`:''}${c.notes?`<p class="field-help">${esc(c.notes)}</p>`:''}${evidenceList(c)}</article>`).join('')}</div>`;}
const applicabilityLabel=value=>({applicable:'Applies to this scope',conditional:'Depends on project scope',not_applicable:'Not applicable — see basis',unresolved:'Applicability unresolved'})[value]||value;
function codeCount(r){return (r?.codes?.length||0)+(r?.fireStandards?.length||0);}
function codesView(r){
  const fire=state.detail.fireProfile?.length>0;
  const inactive=!['queued','researching','waiting_batch','waiting','canceling','needs_key'].includes(state.detail.project.status);
  const canUpdate=fire&&inactive&&state.detail.stages.filter(s=>['jurisdiction','contacts'].includes(s.id)).every(s=>s.status==='complete')&&!state.detail.attempts.some(a=>['unknown','dispatching','pending','received'].includes(a.state));
  const intro=fire?`<section class="panel panel-padding report-section"><div class="finding-top"><h2>Fire protection · NFPA standards</h2>${canUpdate?'<button class="button secondary" id="refresh-nfpa">Research NFPA standards</button>':''}</div><p>Each standard is checked for its adopted edition, legal basis, amendments, and relevance to your project. A screening target is not automatically a requirement.</p>${!r?.fireProtection?'<p class="field-help">This report has not completed the individual NFPA checklist. Run the focused update to investigate the missing standards; saved jurisdiction and contact research are reused.</p>':`<p class="field-help">${r.fireStandards.length} individual findings · ${r.fireProtection.unresolved} need confirmation.${r.fireProtection.scopeConditional!==undefined?` ${r.fireProtection.scopeConditional} depend on project scope; ${r.fireProtection.applicabilityUnresolved} have unresolved applicability; ${r.fireProtection.evidenceUnresolved} still need evidence confirmation. These counts can overlap.`:" Scope-dependent and unresolved entries remain visible."}</p>`}<details><summary>Standards screened for this project</summary><p class="field-help">${state.detail.fireProfile.map(t=>esc(t.standard+' — '+t.topic)).join('<br>')}</p></details></section>`:'';
  if(!r)return intro+empty('Tracing adopted editions','The final tables appear after evidence review. Working research is saved in Overview.');
  return intro+'<p class="field-help" style="margin-bottom:18px">“Source-supported” means supporting passages were matched to retrieved text. Confirm applicability and unresolved amendments with the responsible authority.</p>'+(r.fireStandards?.length?codeTable(r.fireStandards):'')+(r.codes.length?`<section class="report-section" style="margin-top:28px">${fire?'<h2>Governing codes & other standards</h2>':''}${codeTable(r.codes)}</section>`:'');
}
function codeTable(rows){return `<div class="table-wrap"><table><thead><tr><th>Code / standard</th><th>Edition</th><th>Authority & adoption</th><th>Evidence status</th><th>Applicability & evidence</th></tr></thead><tbody>${rows.map(c=>`<tr><td><strong>${esc(c.name)}</strong></td><td><strong>${esc(c.edition||'Unconfirmed')}</strong><small>${c.effectiveDate?'Effective '+esc(c.effectiveDate):'Effective date unconfirmed'}</small></td><td>${esc(c.authority)}<small>${esc(({direct:'Direct adoption',referenced:'Incorporated by reference',guidance:'Agency guidance',unconfirmed:'Adoption unconfirmed'})[c.adoptionType]||c.adoptionType)}</small><small>${esc(c.adoptionInstrument)}</small></td><td>${badge(c.status)}</td><td class="code-detail">${c.applicabilityStatus?`<strong>${esc(applicabilityLabel(c.applicabilityStatus))}</strong>`:''}<p>${esc(c.applicability)}</p><details><summary>View amendments & sources</summary><p><strong>Local amendments:</strong> ${esc(c.amendments||'Not confirmed')}</p>${c.notes?`<p>${esc(c.notes)}</p>`:''}${evidenceList(c)}</details></td></tr>`).join('')}</tbody></table></div>`;}
// A document the user has (an AHJ letter, an emailed amendment, owner or insurer criteria) joins the register.
const uploadForm=()=>`<form class="source-upload" id="document-upload"><div><h3>Add a document you have</h3><p class="field-help">PDF, HTML or plain text, up to 50 MB. It is saved in this project as a source you provided, which chat can quote right away. Continue research to include it in the report. Save Word files as PDF first; a scanned PDF needs text recognition.</p></div><div class="source-upload-row"><label class="visually-hidden" for="document-file">Document to add</label><input type="file" id="document-file" accept=".pdf,.txt,.text,.md,.csv,.json,.htm,.html,application/pdf,text/plain,text/html,text/markdown,text/csv"><button class="button secondary" type="submit">Add document</button></div><div class="inline-error" role="alert" id="document-error"></div></form>`;
function sourcesView(sources){if(!sources.length)return uploadForm()+empty('No sources yet','Official webpages, ordinances, maps, and documents will be recorded here as they are found.');return uploadForm()+sources.map(s=>`<article class="source-card" id="source-${esc(s.id)}"><div class="finding-top"><span class="eyebrow">${esc(s.id)} · ${esc(s.kind==='upload'?'your document':s.kind.replace('-',' '))}</span><span class="status-pill ${s.read_full?'green':''}">${s.read_full?'Read as evidence':'Discovered / visual only'}</span></div><h3>${link(s.url,s.title)||esc(s.title)}</h3><p>${s.kind==='upload'?'Added by you to this project':esc(s.url)}</p><p>${s.kind==='upload'?'Added':'Retrieved'} ${esc(date(s.retrieved))}${s.document_date?' · Source modified '+esc(s.document_date):''}</p>${s.text?`<details><summary>Inspect retrieved excerpt</summary><div class="source-excerpt">${esc(s.text)}</div></details>`:'<p>Search discovery only. No full-source passage has been retrieved.</p>'}</article>`).join('');}
function activityView(detail){
  const {project:p,attempts,events}=detail;
  const used=attempts.filter(a=>Number.isFinite(a.usage?.output_tokens));
  const tokens=used.reduce((n,a)=>({input:n.input+Number(a.usage.input_tokens||0)+Number(a.usage.cache_read_input_tokens||0)+Number(a.usage.cache_creation_input_tokens||0),cached:n.cached+Number(a.usage.cache_read_input_tokens||0),output:n.output+Number(a.usage.output_tokens||0)}),{input:0,cached:0,output:0});
  const count=n=>Number(n).toLocaleString();
  return `<div class="report-grid"><section><h2>Research activity</h2><ol class="activity">${events.map(e=>`<li><time>${esc(date(e.time))}</time><span>${esc(e.message)}</span></li>`).join('')}</ol></section><aside><div class="panel panel-padding"><span class="eyebrow">SPENDING RECORD</span><h2>${money(p.cost)} <span class="optional">estimated API cost</span></h2><p class="cost-detail">${money(attempts.filter(a=>a.stage_id==='chat').reduce((n,a)=>n+a.actual,0)/1e6)} of this is project chat.<br>${money(p.reserved)} estimated for pending or uncertain requests.<br>${p.searches} research searches · ${p.reads} research source reads · ${attempts.filter(a=>a.stage_id==='chat').reduce((n,a)=>n+Number(a.usage?.server_tool_use?.web_search_requests||0),0)} chat searches.</p><p class="field-help">The provider’s invoice is authoritative. Native search has variable input costs; a running request may exceed its estimate.</p><div class="section-divider"></div><h3>Recorded usage</h3><p class="field-help">${used.length} requests with usage recorded (${used.filter(a=>a.estimated).length} estimated from interrupted streams or incomplete pricing details)<br>${count(tokens.input)} input tokens<br>${count(tokens.cached)} cached input tokens (${tokens.input?Math.round(tokens.cached/tokens.input*100):0}%)<br>${count(tokens.output)} output tokens, including thinking; interrupted output may be estimated</p><p class="field-help">Output ceilings: 60,000 per research or evidence-check request; 100,000 for the final report; ${(state.detail.chat?.limits?.output||128000).toLocaleString()} per chat request (the model’s maximum). Only actual token use is billed.</p></div>${attempts.filter(a=>a.batch_id||a.state==='unknown'||a.state==='errored').map(a=>`<div class="source-card" style="margin-top:15px"><h3>${esc(stageLabels[a.stage_id]||a.stage_id)} · ${esc(a.state)}${a.estimated?' · estimated':''}</h3><p>Request: ${esc(a.id)}</p>${a.request_id?`<p>Provider request: ${esc(a.request_id)}</p>`:''}${a.batch_id?`<p>Batch: ${esc(a.batch_id)}</p>`:''}<p>Estimated charge: ${money(a.actual/1e6)}</p>${a.state==='unknown'?`<button class="button secondary" data-resolve="${esc(a.id)}">Resolve uncertain charge</button>`:''}</div>`).join('')}</aside></div>`;
}
function projectNameEditor(p){
  const draft=nameDrafts.has(p.id)?nameDrafts.get(p.id):p.name,busy=nameBusy.has(p.id),unchanged=draft.trim()===p.name;
  return `<form id="rename-form" class="project-name-form"><h1><label for="project-name">Project name</label></h1><div class="project-name-row"><input id="project-name" name="name" required maxlength="100" autocomplete="off" value="${esc(draft)}" ${busy?'disabled':''}><button class="button secondary" type="submit" id="save-project-name" ${busy||unchanged?'disabled':''}>${busy?'Saving…':'Save name'}</button></div><p class="field-help" id="rename-help">Saving the name does not stop research or change saved findings.</p><div class="inline-error" role="alert" id="rename-error">${esc(nameErrors.get(p.id)||'')}</div></form>`;
}
async function saveProjectName(e){
  e.preventDefault();
  const id=state.selected,name=$('#project-name')?.value;
  if(!id||name==null)return;
  nameBusy.add(id);nameErrors.delete(id);renderProject();
  try{
    const saved=await api(`/api/projects/${id}/rename`,{method:'POST',body:{name}});
    nameDrafts.delete(id);applySavedProject(saved);toast('Project name saved.');
    await refreshProjects();
    if(state.selected===id)await refreshSelected();
  }catch(error){nameErrors.set(id,error.message);}
  finally{nameBusy.delete(id);if(state.selected===id)renderProject();}
}
function renderProject(){
  if(!state.detail)return;const {project:p,stages,sources,attempts}=state.detail,r=p.report;
  const focused=document.activeElement,editing=focused?.matches('[data-question-form] textarea, #chat-form textarea, #chat-form input, .chat-proposal select, .chat-proposal button, #project-name')?{id:focused.id,start:focused.selectionStart,end:focused.selectionEnd}:null;
  const chatHistory=$('#chat-history'),chatScroll=chatHistory?{top:chatHistory.scrollTop,bottom:chatHistory.scrollHeight-chatHistory.scrollTop-chatHistory.clientHeight<40}:null;
  const openDetails=[...document.querySelectorAll('#main details[open]')].map(d=>d.closest('[id]')?.id).filter(Boolean);
  const active=['queued','researching','waiting_batch','waiting'].includes(p.status),uncertain=attempts.some(a=>a.state==='unknown');
  const canStop=!p.cancel_requested&&(active||attempts.some(a=>a.stage_id!=='chat'&&['dispatching','pending','received'].includes(a.state)));
  $('#breadcrumb').innerHTML='WORKSPACE <span>/</span> PROJECT RESEARCH';
  $('#main').innerHTML=`<div class="intro"><div><span class="eyebrow">PROJECT RESEARCH</span>${projectNameEditor(p)}<p>${esc(p.address)}</p>${p.input?.siteDescription?`<p class="field-help">Parcel / site: ${esc(p.input.siteDescription)}</p>`:''}<div class="report-meta"><span>${esc(p.discipline)}</span><span>·</span><span>${esc(p.input?.country||'United States')}</span><span>·</span><span>${p.mode==='batch'?'Batch processing':'Real-time research'}</span>${badge(p.status)}</div></div><div class="project-actions"><button class="button secondary danger" id="delete-project">Delete project</button>${canStop?'<button class="button secondary danger" id="cancel-research">Stop research</button>':''}${!active&&!state.detail.chat?.active&&!['canceling','needs_key'].includes(p.status)&&!uncertain?'<button class="button secondary" id="resume-research">'+(researchComplete()?'Review or extend report':'Continue research')+'</button>':''}${p.status==='needs_key'?'<button class="button primary" id="project-connect">Connect Claude</button>':''}<details class="export-menu"><summary class="button secondary">Export <span aria-hidden="true">⌄</span></summary><div class="export-options">${[['pdf','PDF report'],['xlsx','Excel workbook'],['xlsx-essentials','Excel essentials'],['json','Research data (JSON)']].map(([f,label])=>`<a href="/api/projects/${p.id}/export?format=${f}" download>${label}</a>`).join('')}</div></details></div></div>
  <div class="summary-strip"><div class="summary-stat"><small>AUTHORITIES</small><strong>${r?r.authorities.length:'—'}</strong><em>${r?'identified':'researching'}</em></div><div class="summary-stat"><small>CODE & STANDARD FINDINGS</small><strong>${r?codeCount(r):'—'}</strong><em>${r?'entries':'researching'}</em></div><div class="summary-stat"><small>EVIDENCE SOURCES</small><strong>${sources.length}</strong><em>${sources.filter(s=>s.read_full).length} read</em></div><div class="summary-stat"><small>ESTIMATED COST</small><strong style="font-size:1.15rem">${money(p.cost)}</strong><em>to date</em><small style="margin:7px 0 0">${money(p.reserved)} pending</small></div></div>
  <div class="stages">${stages.map((s,i)=>`<div class="stage ${s.status==='complete'?'done':['running','preparing','waiting_batch'].includes(s.status)?'current':''}"><small>${s.status==='complete'?'✓':'0'+(i+1)} &nbsp; STAGE ${i+1}</small><strong>${esc(stageLabels[s.id]||s.id)}</strong><p>${esc(({queued:'Waiting',running:'Researching…',preparing:'Preparing request…',waiting_batch:'Awaiting batch result',complete:'Brief complete',partial:'Partial findings',blocked:'Needs attention'})[s.status]||s.status)}</p></div>`).join('')}</div>
  ${p.note?`<div class="notice ${['queued','researching','waiting_batch'].includes(p.status)?'info':''}"><p>${esc(p.note)}</p>${['budget','attention'].includes(p.status)&&!attempts.some(a=>['dispatching','pending','received','unknown'].includes(a.state))&&stages.some(s=>s.id!=='review'&&!['complete','partial'].includes(s.status))?'<button class="button secondary" id="finish-partial">Finish with saved evidence</button>':''}${uncertain&&attempts.some(a=>a.mode==='batch'&&a.state==='unknown')?'<button class="button secondary" id="recover-batch">Reconcile original batch</button>':''}${uncertain?'<p class="field-help">Open Activity to inspect request identifiers and manually reconcile a confirmed charge.</p>':''}</div>`:''}
  <div class="tabs" role="tablist" aria-label="Project report">${[['overview','Overview',p.questions?.filter(q=>q.status==='open').length],['contacts','Contacts',r?.contacts.length],['codes','Codes & standards',codeCount(r)],['sources','Sources',sources.length],['chat','Chat with Atlas',null],['activity','Activity',null]].map(([id,label,count])=>`<button class="tab ${state.tab===id?'active':''}" role="tab" aria-selected="${state.tab===id}" aria-controls="report-content" data-tab="${id}">${label}${count?`<span class="tab-count">${count}</span>`:''}</button>`).join('')}</div><div id="report-content" role="tabpanel">${state.tab==='chat'?chatView(state.detail):state.tab==='contacts'?contactsView(r):state.tab==='codes'?codesView(r):state.tab==='sources'?sourcesView(sources):state.tab==='activity'?activityView(state.detail):overview(state.detail)}</div>`;
  for(const b of document.querySelectorAll('[data-tab]'))b.addEventListener('click',()=>{state.tab=b.dataset.tab;renderProject();});
  for(const b of document.querySelectorAll('[data-source]'))b.addEventListener('click',()=>{const id=b.dataset.source;state.tab='sources';renderProject();document.getElementById('source-'+id)?.scrollIntoView({behavior:'smooth',block:'center'});});
  $('#document-upload')?.addEventListener('submit',addDocument);
  for(const b of document.querySelectorAll('[data-delete-note]'))b.addEventListener('click',()=>removeNote(b));
  $('#delete-project').addEventListener('click',()=>openAction('delete'));
  $('#rename-form')?.addEventListener('submit',saveProjectName);
  $('#project-name')?.addEventListener('input',e=>{
    const id=state.selected;if(!id||!state.detail)return;
    if(e.target.value===state.detail.project.name)nameDrafts.delete(id);else nameDrafts.set(id,e.target.value);
    nameErrors.delete(id);const err=$('#rename-error');if(err)err.textContent='';
    const button=$('#save-project-name');if(button&&!nameBusy.has(id))button.disabled=e.target.value.trim()===state.detail.project.name;
  });
  for(const b of document.querySelectorAll('[data-resolve]'))b.addEventListener('click',()=>openAction('resolve',b.dataset.resolve));
  for(const id of openDetails){const parent=document.getElementById(id);const d=parent?.matches('details')?parent:parent?.querySelector('details');if(d)d.open=true;}
  for(const form of document.querySelectorAll('[data-question-form]')){
    form.addEventListener('submit',e=>{e.preventDefault();saveQuestion(form.closest('[data-question]'),'answered');});
    $('textarea',form).addEventListener('input',e=>questionDrafts.set(state.selected+':'+form.dataset.questionForm,e.target.value));
  }
  for(const button of document.querySelectorAll('[data-question-action]'))button.addEventListener('click',()=>saveQuestion(button.closest('[data-question]'),button.dataset.questionAction));
  for(const button of document.querySelectorAll('[data-ask-atlas]'))button.addEventListener('click',()=>askAtlas(button.closest('[data-question]')));
  $('#research-answers')?.addEventListener('click',()=>openAction('resume'));
  bindChat();
  revealActiveTab();
  if(editing){const field=document.getElementById(editing.id);field?.focus({preventScroll:true});if(typeof editing.start==='number')field?.setSelectionRange(editing.start,editing.end);}
  const history=$('#chat-history');if(history)history.scrollTop=!chatScroll||chatScroll.bottom?history.scrollHeight:chatScroll.top;
  $('#refresh-nfpa')?.addEventListener('click',()=>openAction('nfpa'));$('#cancel-research')?.addEventListener('click',()=>openAction('cancel'));$('#resume-research')?.addEventListener('click',()=>openAction('resume'));$('#finish-partial')?.addEventListener('click',()=>openAction('partial'));$('#recover-batch')?.addEventListener('click',()=>openAction('reconcile'));$('#project-connect')?.addEventListener('click',openSettings);
}
// Source references such as [S1] open the saved source when it is in this project.
const sourceReference=id=>state.detail?.sources.some(s=>s.id===id)?`<button class="banner-link" data-source="${esc(id)}" aria-label="Open source ${esc(id)}">[${esc(id)}]</button>`:null;
function chatText(text){return renderMarkdown(text,{references:sourceReference});}
function citationHtml(turn,part,partIndex){
  return (part.citations||[]).map((c,citationIndex)=>{
    const id=`chat-citation-${esc(turn.id)}-${partIndex}-${citationIndex}`;
    // A web search snippet is shown as a lead to a page, never as supporting evidence.
    if(c.kind==='lead')return href(c.url)?`<details class="chat-citation chat-lead" id="${id}"><summary aria-label="Read search lead from ${esc(new URL(c.url).hostname)}">[Web] Search lead</summary><div class="chat-citation-body"><strong>${link(c.url,c.title||c.url)}</strong><blockquote>${esc(c.quote)}</blockquote><p class="field-help">Search snippet: a lead, not verified evidence. Read the page before relying on it.</p></div></details>`:'';
    if(!/^S\d+$/.test(c.sourceId)||!state.detail?.sources.some(s=>s.id===c.sourceId))return '';
    return `<details class="chat-citation" id="${id}"><summary aria-label="Read supporting passage from ${esc(c.sourceId)}">[${esc(c.sourceId)}] Supporting passage</summary><div class="chat-citation-body"><strong>${esc(c.title)}</strong><blockquote>${esc(c.quote)}</blockquote><button class="text-button" data-source="${esc(c.sourceId)}">Open source ${esc(c.sourceId)}</button></div></details>`;
  }).join('');
}
// The answer is rendered as one Markdown document so lists and tables survive citation
// boundaries. Private-use markers hold each part's citations in place until rendering.
function chatAnswer(turn){
  if(!turn.answerParts?.length)return chatText(turn.answer);
  const citations=[];let text='';
  turn.answerParts.forEach((part,partIndex)=>{
    const body=String(part.text||'').replace(/[\uE000\uE001]/g,''),trail=body.match(/\s*$/)[0],html=citationHtml(turn,part,partIndex);
    text+=body.slice(0,body.length-trail.length)+(html?`\uE000${citations.push(html)-1}\uE001`:'')+trail;
  });
  return chatText(text).replace(/\uE000(\d+)\uE001/g,(m,n)=>citations[n]||'');
}
function revealActiveTab(){
  const tabs=$('.tabs'),active=$('.tab.active');if(!tabs||!active)return;
  const left=active.getBoundingClientRect().left-tabs.getBoundingClientRect().left+tabs.scrollLeft;
  if(left<tabs.scrollLeft)tabs.scrollLeft=left;
  else if(left+active.offsetWidth>tabs.scrollLeft+tabs.clientWidth)tabs.scrollLeft=left+active.offsetWidth-tabs.clientWidth;
}
window.addEventListener('resize',revealActiveTab);
function chatTurns(detail){
  const rows=new Map([...(chatOlder.get(detail.project.id)?.turns||[]),...(detail.chat?.turns||[])].map(t=>[t.id,t]));
  return [...rows.values()].sort((a,b)=>a.created.localeCompare(b.created));
}
const effortLabel=effort=>({medium:'Medium',high:'High',xhigh:'Extra-high',max:'Maximum'})[effort]||effort;
const modeHelp=m=>`${m.model} · ${effortLabel(m.effort)} reasoning · ${m.id==='economy'?'Focused saved excerpts; all project records and source tools remain available':'This project’s context and conversation only'}`;
function economyCostHelp(){
  const m=state.bootstrap?.models?.economy;if(!m)return 'Economy uses Haiku 5.5 at medium effort for summaries and straightforward project questions.';
  const tier=m.longContext;
  return `Economy uses Haiku 5.5 at medium effort for summaries and straightforward project questions. Per million tokens, input/output cost ${money(m.input)}/${money(m.output)} for prompts up to ${Number(tier.threshold).toLocaleString('en-US')} tokens, and ${money(tier.input)}/${money(tier.output)} above that, including cached prompt tokens. It starts with shorter saved excerpts; all project records and source tools stay available. Longer replies can enter the higher price tier. Web-tool costs may be conservatively estimated when the provider omits per-prompt usage.`;
}
const chatStatusLabels={complete:'Reply complete',limited:'Limit reached',failed:'Reply failed',stopped:'Stopped',interrupted:'Interrupted',attention:'Needs attention',declined:'Declined by Claude'};
// A running reply shows its streamed text and current step; the page patches both in place.
function chatLive(t){return `<div class="chat-prose chat-draft" data-chat-draft>${t.draft?chatText(t.draft):''}</div><p class="chat-note chat-step" data-chat-step>${esc(t.note||'Working…')}</p>`;}
function chatRetry(t,modes,busy){
  const m=modes.find(m=>m.id===t.retryMode);if(!m)return '';
  return `<div class="chat-retry"><button type="button" class="button secondary" data-chat-retry="${esc(t.id)}" ${busy?'disabled':''}>Try again with ${esc(m.label)}</button><span class="field-help">Sends the same message to ${esc(m.model)}${m.id==='opus'?', at about twice Sonnet 5.5’s per-token price':''}.</span></div>`;
}
const proposalTitles={answer_question:'Answer a question',dismiss_question:'Dismiss a question',report_note:'Save a note to the report',research:'Start a research round',nfpa_research:'Start focused NFPA research',correct_location:'Correct the project location'};
const paidProposal=x=>['research','nfpa_research','correct_location'].includes(x.action);
// Applying a free proposal from an Ask Atlas reply also dismisses the asked question while it
// is open, unless the reply has its own card for that question. The server applies the same rule.
const dismissesAsked=(t,x,p)=>Boolean(t?.askedQuestionId)&&!paidProposal(x)&&!t.proposals.some(y=>y.questionId===t.askedQuestionId)&&(p.questions||[]).some(q=>q.id===t.askedQuestionId&&q.status==='open');
// Why a proposal cannot be applied now, or '' when it can. The server checks again on Apply.
function proposalBlocked(x,detail){
  const p=detail.project;
  if(x.action==='report_note')return (detail.notes||[]).some(n=>n.text===x.note)?'This note is already saved in the report.':'';
  if(!paidProposal(x)){
    const q=(p.questions||[]).find(q=>q.id===x.questionId);if(!q)return 'This question is no longer in the saved report.';
    const status=x.action==='answer_question'?'answered':'dismissed';
    return q.status===status&&(status==='dismissed'||q.answer===x.answer)?'This response is already saved.':'';
  }
  if(x.stale)return 'Research has run since this was proposed. Ask chat again if it still applies.';
  if(detail.chat?.active||chatPending.has(p.id))return 'Available when the current reply finishes.';
  if(['queued','researching','waiting_batch','waiting','canceling','needs_key'].includes(p.status)||detail.attempts.some(a=>['dispatching','pending','received','unknown'].includes(a.state)))return 'Available when the current research and outstanding requests have settled.';
  if(x.action==='nfpa_research'&&!(detail.fireProfile?.length&&detail.stages.filter(s=>['jurisdiction','contacts'].includes(s.id)).every(s=>s.status==='complete')))return 'Requires completed jurisdiction and contact research on a fire protection project.';
  const site=p.input?.siteDescription||'';
  if(x.action==='correct_location'&&(x.address||p.address)===p.address&&(x.siteDescription||site)===site&&(!x.country||x.country===countryName(p.input?.country||'United States')))return 'The project already uses this location.';
  return '';
}
// A proposal is shown exactly as saved; Apply sends only its identifiers, never this text.
function chatProposal(t,x,detail){
  const p=detail.project,key=`${p.id}:${t.id}:${x.id}`,dom=`${t.id}-${x.id}`,paid=paidProposal(x),applied=x.status==='applied',busy=proposalBusy.has(key);
  const blocked=applied?'':proposalBlocked(x,detail),otherBusy=paid&&[...proposalBusy].some(k=>k!==key&&k.startsWith(p.id+':'));
  const q=(p.questions||[]).find(q=>q.id===x.questionId),text=(label,value)=>`<p class="chat-proposal-label">${label}</p><p class="chat-proposal-text">${esc(value)}</p>`;
  let body='';
  if(x.action==='report_note')body=`${text('Note title',x.title)}${text('Note',x.note)}<p class="field-help">Saved notes appear on Overview and in the PDF, Excel and JSON exports, and are kept when research rebuilds the report. Applying is free.</p>`;
  else if(!paid)body=`<p class="chat-proposal-question">${esc(x.question||q?.question||'')}</p>${x.action==='answer_question'?text('Proposed answer',x.answer):''}${!applied&&q&&q.status!=='open'?`<p class="field-help">Currently ${q.status==='answered'?`answered: “${esc(q.answer)}”`:'dismissed'}.</p>`:''}`;
  else if(x.action==='research')body=text('New project context',x.clarification);
  else if(x.action==='nfpa_research')body='<p class="chat-proposal-summary">Research the individual NFPA standards, check the evidence, and rebuild the report. Saved jurisdiction and contact research are retained.</p>';
  else body=`${x.address?`${text('Proposed address',x.address)}${applied?'':`<p class="field-help">Currently: ${esc(p.address)}</p>`}`:''}${x.country?`${text('Proposed country',x.country)}${applied?'':`<p class="field-help">Currently: ${esc(p.input?.country||'United States')}</p>`}`:''}${x.siteDescription?`${text('Proposed parcel number or site description',x.siteDescription)}${applied?'':`<p class="field-help">Currently: ${esc(p.input?.siteDescription||'none')}</p>`}`:''}`;
  const mode=proposalModes.get(key)||p.mode;
  const cost=paid&&!applied?`<p class="field-help">Applying starts a paid research round that rebuilds the report${x.action==='correct_location'?', reopening jurisdiction research for the new location':''}. ${money(p.cost)} estimated for this project so far.${p.questionResponses?.length?' Saved answers and dismissals are included automatically.':''}</p><div class="chat-proposal-mode"><label for="proposal-mode-${dom}">Processing mode</label><select id="proposal-mode-${dom}" data-proposal-mode ${busy?'disabled':''}>${[['realtime','Research now'],['batch','Research later (batch)']].map(([v,l])=>`<option value="${v}" ${mode===v?'selected':''}>${l}</option>`).join('')}</select></div>`:'';
  const asked=!applied&&!blocked&&dismissesAsked(t,x,p)?'<p class="field-help">Applying also dismisses the question you asked Atlas about. You can reopen it on Overview.</p>':'';
  const action=applied?`<span class="status-pill green">Applied ${esc(date(x.applied))}</span>`:`<button type="button" class="button primary" id="proposal-apply-${dom}" data-proposal-apply ${busy||blocked||otherBusy?'disabled':''}>${busy?'Applying…':paid?'Apply and start research':'Apply'}</button>${blocked?`<span class="field-help">${esc(blocked)}</span>`:''}`;
  return `<article class="chat-proposal" data-proposal="${esc(x.id)}" data-proposal-turn="${esc(t.id)}"><span class="eyebrow">PROPOSED ACTION</span><h3>${esc(proposalTitles[x.action]||'Proposed change')}</h3>${body}${x.reason?`<p class="field-help">Reason: ${esc(x.reason)}</p>`:''}${asked}${cost}<div class="chat-proposal-actions">${action}</div><div class="inline-error" role="alert">${esc(proposalErrors.get(key)||'')}</div></article>`;
}
function chatProposals(t,detail){return detail&&t.status!=='running'&&t.proposals?.length?`<div class="chat-proposals" aria-label="Proposed actions">${t.proposals.map(x=>chatProposal(t,x,detail)).join('')}</div>`:'';}
function chatTurn(t,modes,busy,turns=[],detail=null){
  const running=t.status==='running';
  return `<article class="chat-turn" data-chat-turn="${esc(t.id)}"><div class="chat-message chat-user"><div class="chat-message-label">YOU <time>${esc(date(t.created))}</time></div><div class="chat-prose chat-user-text">${esc(t.user)}</div></div><div class="chat-message chat-assistant"><div class="chat-message-label">ASSISTANT${t.modeLabel?` <span class="chat-mode-label">${esc(t.modeLabel)}</span>`:''} ${running?'<span class="status-pill">Working…</span>':''}</div>${running?chatLive(t):`${t.answer?`<div class="chat-prose">${chatAnswer(t)}</div>`:''}${t.note?`<p class="chat-note ${['failed','attention'].includes(t.status)?'chat-error':t.status==='declined'?'chat-declined':''}">${esc(t.note)}</p>`:''}`}${chatProposals(t,detail)}${t.status==='declined'&&!turns.some(x=>x.created>t.created&&x.user===t.user&&x.mode===t.retryMode)?chatRetry(t,modes,busy):''}${t.status==='attention'?'<button class="text-button" data-chat-activity>Review Activity</button>':''}${!running?`<p class="field-help">${esc(chatStatusLabels[t.status]||t.status)} · ${money(t.cost)} estimated${t.reserved?' · '+money(t.reserved)+' pending':''}</p>`:''}</div></article>`;
}
function chatView(detail){
  const p=detail.project,c=detail.chat||{},turns=chatTurns(detail),busy=Boolean(c.active)||chatPending.has(p.id),options=chatOptions.get(p.id)||{};
  const earlier=chatOlder.get(p.id)?.hasEarlier??c.hasEarlier,modes=c.modes||[],limits=c.limits||{},mode=modes.find(m=>m.id===options.mode)||modes[0];
  const chatCost=(detail.attempts||[]).filter(a=>a.stage_id==='chat').reduce((n,a)=>n+a.actual,0)/1e6;
  return `<section class="chat-panel panel"><div class="chat-heading"><div><span class="eyebrow">PROJECT CONVERSATION</span><h2>Chat about ${esc(p.name)}</h2><p class="field-help" id="chat-mode-help">${mode?esc(modeHelp(mode)):''}</p></div><span class="status-pill green">Project context only</span></div><div class="chat-context"><p>Ask about your report, sources, research notes, or saved answers. The assistant looks through all saved project records, can search the web and read public pages when they don’t answer the question, and cites the evidence.</p><p class="field-help">Pages chat reads join this project’s source register. Search results are shown as leads, not evidence. Chat can propose answers, dismissals, research rounds and location corrections as cards; those proposed edits wait for you to apply them. Reading pages already adds sources and chat charges.</p></div><div class="chat-history" id="chat-history" role="log" aria-label="Project chat" aria-live="polite">${earlier?'<button class="text-button chat-earlier" id="chat-earlier">Show earlier messages</button>':''}${turns.length?turns.map(t=>chatTurn(t,modes,busy,turns,detail)).join(''):empty('Your project, in conversation','Ask which findings need attention, compare the saved code editions, or get help interpreting a cited passage.')}</div><form id="chat-form" class="chat-composer" data-chat-project="${p.id}"><label for="chat-message">Message about ${esc(p.name)}</label><textarea id="chat-message" name="message" rows="3" maxlength="${limits.messageChars||30000}" required placeholder="What should I resolve before submitting this project?" ${busy?'disabled':''}>${esc(chatDrafts.get(p.id)||'')}</textarea><div class="chat-options"><label for="chat-mode">Reply depth</label><select id="chat-mode" ${busy?'disabled':''}>${modes.map(m=>`<option value="${esc(m.id)}" ${m.id===mode?.id?'selected':''}>${esc(m.label)} — ${esc(m.model)}, ${esc(effortLabel(m.effort).toLowerCase())} reasoning</option>`).join('')}</select></div><details id="chat-limits"><summary>How replies work and what they cost</summary><p class="field-help">Each reply can use up to ${esc(limits.requests)} requests, ${esc(limits.toolCalls)} lookups, ${esc(limits.searches)} web searches (${esc(limits.searchesPerRequest)} per request), ${esc(limits.webReads)} public page reads (Anthropic web fetches included) and about ${esc(limits.minutes)} minutes of lookups, then writes its final answer from what it found. There is no spending limit; each reply shows its estimated cost. Web searches cost $10 per 1,000 plus the tokens of their results. Chat’s web allowance is separate from research’s.</p><p class="field-help">${esc(economyCostHelp())} Standard uses Sonnet 5.5 at high effort for most questions. Premium uses Opus 5.5 at high effort for the hardest analysis, at about twice Sonnet’s input/output price. Replies use real-time pricing, including for batch projects.</p><p class="field-help">The project’s evidence is cached for an hour, so follow-up questions in the same hour cost less than the first. Pages a reply reads change the evidence, so the next reply rebuilds that cache.</p></details><div id="chat-error" class="inline-error" role="alert">${esc(chatErrors.get(p.id)||'')}</div><div class="chat-send-row"><p class="field-help">${money(p.cost)} estimated for this project · ${money(chatCost)} from chat${p.reserved?' · '+money(p.reserved)+' pending':''}</p>${c.active?'<button type="button" class="button secondary" id="chat-stop">Stop reply</button>':`<button type="submit" class="button primary" ${busy?'disabled':''}>${busy?'Sending…':'Send message'}</button>`}</div></form></section>`;
}
async function sendChat(id,request,fromComposer=false){
  chatPending.add(id);chatErrors.delete(id);renderProject();
  try{
    const chat=await api(`/api/projects/${id}/chat`,{method:'POST',body:request});
    if(fromComposer){chatRequests.delete(id);if(chatDrafts.get(id)===request.message)chatDrafts.delete(id);}
    if(state.selected===id&&state.detail?.project.id===id){state.detail.chat=chat;await refreshSelected();}
    return true;
  }catch(error){chatErrors.set(id,error.message);return false;}
  finally{chatPending.delete(id);if(state.selected===id&&state.detail?.project.id===id)renderProject();}
}
// Ask Atlas starts the same chat reply as Send message, for this question. The selected
// reply depth is the model's setting; Apply on the reply is still what writes the project.
async function askAtlas(card){
  const id=state.selected;if(!id||!state.detail)return;
  if(!state.bootstrap?.keyConfigured){openSettings();return;}
  const questionId=card?.dataset.question;if(!questionId)return;
  if(chatPending.has(id)||state.detail.chat?.active){
    state.tab='chat';chatErrors.set(id,'Wait for this project’s current reply to finish.');renderProject();return;
  }
  const modes=state.detail.chat?.modes||[],chosen=chatOptions.get(id)?.mode;
  const mode=modes.some(m=>m.id===chosen)?chosen:(modes[0]?.id||'standard');
  const key=id+':'+questionId;
  let request=atlasRequests.get(key);
  if(!request||request.mode!==mode)request={questionId,mode,clientId:crypto.randomUUID()};
  atlasRequests.set(key,request);
  state.tab='chat';
  if(await sendChat(id,request))atlasRequests.delete(key);
}
// Apply is the user's approval. The server applies the saved proposal, identified by turn and id.
async function applyProposal(id,card){
  const turnId=card.dataset.proposalTurn,proposalId=card.dataset.proposal,key=`${id}:${turnId}:${proposalId}`;
  const turn=chatTurns(state.detail).find(t=>t.id===turnId),proposal=turn?.proposals?.find(x=>x.id===proposalId);
  if(!proposal||proposalBusy.has(key))return;
  const mode=proposalModes.get(key)||state.detail.project.mode,dismisses=dismissesAsked(turn,proposal,state.detail.project);
  proposalBusy.add(key);proposalErrors.delete(key);renderProject();
  try{
    const chat=await api(`/api/projects/${id}/chat/apply`,{method:'POST',body:{turnId,proposalId,...(paidProposal(proposal)?{mode}:{})}});
    // Turns shown through "Show earlier messages" are outside the latest view the server returns.
    const older=chatOlder.get(id);if(older)older.turns=older.turns.map(t=>t.id===turnId?{...t,proposals:t.proposals.map(x=>x.id===proposalId?{...x,status:'applied',applied:new Date().toISOString()}:x)}:t);
    if(proposal.questionId)questionDrafts.delete(id+':'+proposal.questionId);
    if(dismisses)questionDrafts.delete(id+':'+turn.askedQuestionId);
    if(state.selected===id&&state.detail?.project.id===id){state.detail.chat=chat;await refreshSelected();}
    toast(({answer_question:'Answer saved.',dismiss_question:'Question dismissed. You can reopen it on Overview.',report_note:'Note saved to the report. It is on Overview.',research:'Research started.',nfpa_research:'Focused NFPA research started.',correct_location:'Location corrected. Research started.'}[proposal.action]||'Project updated.')+(dismisses?' The question you asked Atlas about is dismissed.':''));
  }catch(error){proposalErrors.set(key,error.message);}
  finally{proposalBusy.delete(key);if(state.selected===id&&state.detail?.project.id===id)renderProject();}
}
function bindChat(){
  const form=$('#chat-form');if(!form)return;const id=form.dataset.chatProject;
  $('#chat-message').addEventListener('input',e=>chatDrafts.set(id,e.target.value));
  $('#chat-mode')?.addEventListener('change',e=>{chatOptions.set(id,{...chatOptions.get(id),mode:e.target.value});const m=state.detail?.chat?.modes?.find(m=>m.id===e.target.value);if(m)$('#chat-mode-help').textContent=modeHelp(m);});
  form.addEventListener('submit',e=>{
    e.preventDefault();if(chatPending.has(id)||state.detail?.chat?.active)return;
    if(!state.bootstrap.keyConfigured){openSettings();return;}
    const message=$('#chat-message',form).value,mode=$('#chat-mode',form)?.value||'standard';
    let request=chatRequests.get(id);if(!request||request.message!==message||request.mode!==mode)request={message,mode,clientId:crypto.randomUUID()};chatRequests.set(id,request);
    sendChat(id,request,true);
  });
  // A declined message can be sent again to the suggested model, which uses different safeguards.
  for(const button of document.querySelectorAll('[data-chat-retry]'))button.addEventListener('click',()=>{
    if(chatPending.has(id)||state.detail?.chat?.active)return;
    const turn=chatTurns(state.detail).find(t=>t.id===button.dataset.chatRetry);if(!turn?.retryMode)return;
    const key=id+':'+turn.id;if(!chatRetries.has(key))chatRetries.set(key,{message:turn.user,mode:turn.retryMode,clientId:crypto.randomUUID()});
    sendChat(id,chatRetries.get(key));
  });
  $('#chat-stop')?.addEventListener('click',async()=>{const turnId=state.detail.chat.active;try{const chat=await api(`/api/projects/${id}/chat/stop`,{method:'POST',body:{turnId}});if(state.selected===id&&state.detail?.project.id===id){state.detail.chat=chat;renderProject();}}catch(e){chatErrors.set(id,e.message);if(state.selected===id)renderProject();}});
  $('#chat-earlier')?.addEventListener('click',async e=>{e.target.disabled=true;try{const before=chatTurns(state.detail)[0]?.id,chat=await api(`/api/projects/${id}/chat?before=${encodeURIComponent(before)}`),previous=chatOlder.get(id)?.turns||[];chatOlder.set(id,{turns:[...chat.turns,...previous],hasEarlier:chat.hasEarlier});if(state.selected===id&&state.detail?.project.id===id){renderProject();$('#chat-history').scrollTop=0;}}catch(e){chatErrors.set(id,e.message);if(state.selected===id)renderProject();}});
  for(const button of document.querySelectorAll('[data-chat-activity]'))button.addEventListener('click',()=>{state.tab='activity';renderProject();});
  for(const select of document.querySelectorAll('[data-proposal-mode]'))select.addEventListener('change',e=>{const card=e.target.closest('[data-proposal]');proposalModes.set(`${id}:${card.dataset.proposalTurn}:${card.dataset.proposal}`,e.target.value);});
  for(const button of document.querySelectorAll('[data-proposal-apply]'))button.addEventListener('click',()=>applyProposal(id,button.closest('[data-proposal]')));
}
function researchComplete(){return Boolean(state.detail)&&state.detail.stages.filter(s=>s.id!=='review').every(s=>s.status==='complete');}
function openAction(type,attemptId){
  const p=state.detail.project;state.action={type,id:p.id,attemptId};$('#action-error').textContent='';
  $('#action-title').textContent=({delete:'Delete this project?',nfpa:'Research NFPA standards',resume:researchComplete()?'Review or extend report':'Continue project research',partial:'Finish a partial report',cancel:'Stop this research?',reconcile:'Reconcile the original batch',resolve:'Resolve an uncertain charge'})[type];
  $('#action-submit').textContent=({delete:'Delete project',nfpa:'Start focused NFPA research',resume:researchComplete()?'Start paid review / research':'Continue research',partial:'Prepare partial report',cancel:'Stop research',reconcile:'Check batch results',resolve:'Record confirmed charge'})[type];
  let html='';
  if(type==='delete')html=`<p>Permanently delete <strong>${esc(p.name)}</strong> and its saved report, sources, answers, and chat history?</p><p>This cannot be undone. Export anything you want to keep first.</p><p class="field-help">Recorded charges stay in the workspace’s estimated spending totals. Active requests must finish and uncertain charges must be resolved before deletion.</p>`;
  else if(type==='cancel')html='<p>No new requests will be started. Requests already running may finish and incur charges. Collected sources and results will be kept.</p>';
  else if(type==='reconcile')html='<p>Find the original batch in your Anthropic Console. Once it has finished, this app can match its exact request identifier and retrieve the result without resubmitting.</p><label for="batch-id">Original batch ID</label><input id="batch-id" name="batchId" required placeholder="msgbatch_…" autocomplete="off">';
  else if(type==='resolve')html=`<p>Check the original request in your Anthropic Console first. This releases the reservation and records the charge you confirm. It does not cancel a remote batch.</p><label for="actual-cost">Confirmed charge ($)</label><input id="actual-cost" name="actualCost" type="number" min="0" max="100" step="0.000001" required><label for="charge-note" style="margin-top:18px">How did you confirm the outcome?</label><textarea name="note" id="charge-note" rows="3" required maxlength="1000"></textarea><label class="check-label"><input type="checkbox" name="confirmed" required> I confirmed the original request finished, failed, or was canceled and checked its charge.</label>`;
  else html=`<p>${type==='nfpa'?'Research individual NFPA standards, check the evidence, and rebuild the report. Saved jurisdiction and contact research are retained. This uses Claude credits.':type==='partial'?'Prepare a clearly labeled report using the evidence collected so far. This requires a final paid review.':p.questionUpdatesPending?'Your saved answers and dismissals will be included in a new research round. This uses Claude credits.':researchComplete()?'Without new context, a follow-up question or a location correction, this runs a paid review of the saved sources. Add context or correct the location below to reopen research.':'Continue from saved work. Add context or correct the location to recheck the findings, or change processing mode once outstanding requests have settled.'}</p><div class="form-row"><div><label for="resume-mode">Processing mode</label><select id="resume-mode" name="mode"><option value="realtime" ${p.mode==='realtime'?'selected':''}>Research now</option><option value="batch" ${p.mode==='batch'?'selected':''}>Research later (batch)</option></select></div></div><p class="field-help">${money(p.cost)} estimated for this project so far. Costs are recorded as each request finishes.</p>${type==='resume'?'<label for="clarification" style="margin-top:20px">New project context <span class="optional">optional</span></label><textarea name="clarification" id="clarification" rows="3" maxlength="4000" placeholder="Permit date, confirmed AHJ, building use, or a specific question"></textarea><p class="field-help">Adding context reopens the research stages so existing findings can be checked against it.</p><label for="resume-address" style="margin-top:20px">Project address</label><input id="resume-address" name="address" required minlength="8" maxlength="500" autocomplete="street-address" value="'+esc(p.address)+'"><label for="resume-country" style="margin-top:14px">Country</label><select id="resume-country" name="country">'+countryOptions(p.input?.country)+'</select><p class="field-help country-note" id="resume-country-note" aria-live="polite"></p><label for="resume-site" style="margin-top:14px">Parcel number or site description <span class="optional">optional</span></label><input id="resume-site" name="siteDescription" maxlength="500" placeholder="APN, PID, roll or lot number, legal land description, or site location when no street address is assigned" value="'+esc(p.input?.siteDescription||'')+'"><p class="field-help">Correct a typo or a ZIP or postal code, or enter an address assigned after the project was created. A changed address, country or site description reopens jurisdiction research and the stages that depend on it. Saved sources and recorded costs are kept.</p>':''}`;
  if(['resume','nfpa','partial'].includes(type)&&p.questionResponses?.length)html+='<p class="field-help">Saved answers and dismissals are included automatically. User-provided answers remain distinct from source evidence.</p>';
  $('#action-submit').classList.toggle('destructive',type==='delete');
  $('#action-content').innerHTML=html;$('#action-dialog').showModal();
  if(type==='resume'){
    const address=$('#resume-address'),select=$('#resume-country'),note=$('#resume-country-note');
    address.addEventListener('input',()=>syncCountry(address,select,note));
    select.addEventListener('change',()=>{select.dataset.chosen='1';syncCountry(address,select,note);});
  }
  if(type==='delete')$('#action-dialog .dialog-actions [data-close]').focus();
}
$('#action-form').addEventListener('submit',async e=>{
  e.preventDefault();const a=state.action,values=Object.fromEntries(new FormData(e.target)),b=$('#action-submit');b.disabled=true;
  try{
    if(a.type==='delete'){
      await api(`/api/projects/${a.id}`,{method:'DELETE'});
      $('#action-dialog').close();
      for(const cache of [chatDrafts,chatOptions,chatPending,chatErrors,chatRequests,chatOlder])cache.delete(a.id);
      for(const map of [questionDrafts,chatRetries,proposalBusy,proposalErrors,proposalModes,atlasRequests])for(const key of map.keys())if(key.startsWith(a.id+':'))map.delete(key);
      state.projects=state.projects.filter(p=>p.id!==a.id);
      if(state.selected===a.id)newForm();else renderSidebar();
      await refreshProjects();toast('Project deleted.');return;
    }
    const endpoint=['partial','nfpa'].includes(a.type)?'resume':a.type==='resolve'?'resolve-charge':a.type;
    const body=a.type==='cancel'?{}:a.type==='resolve'?{attemptId:a.attemptId,actualCost:Number(values.actualCost),note:values.note,confirmed:values.confirmed==='on'}:a.type==='reconcile'?values:{mode:values.mode,clarification:values.clarification||'',finishPartial:a.type==='partial',...(a.type==='nfpa'?{focus:'fire_protection'}:{}),...(a.type==='resume'?{address:values.address,country:values.country,siteDescription:values.siteDescription||''}:{})};
    await api(`/api/projects/${a.id}/${endpoint}`,{method:'POST',body});$('#action-dialog').close();await refreshSelected();toast(a.type==='cancel'?'Research is stopping. Saved work is retained.':'Project updated.');
  }catch(error){$('#action-error').textContent=error.message;}finally{b.disabled=false;}
});
async function removeNote(button){
  if(!confirm('Remove this note from the report? It stays in the chat conversation.'))return;
  const id=state.selected;button.disabled=true;
  try{const {notes}=await api(`/api/projects/${id}/notes/${encodeURIComponent(button.dataset.deleteNote)}`,{method:'DELETE'});if(state.selected===id&&state.detail){state.detail.notes=notes;renderProject();}toast('Note removed from the report.');}
  catch(error){button.disabled=false;toast(error.message);}
}
async function addDocument(e){
  e.preventDefault();const form=e.currentTarget,file=$('#document-file',form).files?.[0],error=$('#document-error',form),button=$('button[type=submit]',form),id=state.selected;
  error.textContent='';if(!file){error.textContent='Choose a document to add.';return;}
  button.disabled=true;button.textContent='Adding…';
  try{
    let response;try{response=await fetch(`/api/projects/${encodeURIComponent(id)}/documents`,{method:'POST',headers:{'Content-Type':file.type||'application/octet-stream','X-App-Token':state.bootstrap.token,'X-File-Name':encodeURIComponent(file.name)},body:file});}catch(err){recordClientError('The browser could not reach the local application.','/api/projects/documents');throw err;}
    const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error||'The document could not be added.');
    toast(`Added ${data.source.title} as ${data.source.id}.`);await refreshSelected();
  }catch(err){if($('#document-error'))$('#document-error').textContent=err.message;}
  finally{if(button.isConnected){button.disabled=false;button.textContent='Add document';}}
}
async function refreshSelected(){
  const load=projectLoad,generation=++detailGeneration;await refreshProjects();if(!state.selected||load!==projectLoad||generation!==detailGeneration)return;
  const id=state.selected,next=await api(`/api/projects/${id}`);if(state.selected!==id||load!==projectLoad||generation!==detailGeneration)return;
  const stamp=d=>JSON.stringify([d?.project.updated,d?.project.cost,d?.project.reserved,d?.events[0],d?.stages.map(s=>[s.status,s.rounds]),d?.chat]);
  const changed=stamp(next)!==stamp(state.detail);state.detail=next;if(changed)renderProject();
}
setInterval(()=>{if(!document.hidden&&state.bootstrap){refreshSelected().catch(()=>{});refreshConnection().catch(()=>{});}},5000);
// While a reply runs on the visible chat, follow its saved draft and step about once a
// second, patching only that reply. When it finishes, the whole project is refreshed.
let chatFollowing=false;
setInterval(async()=>{
  const detail=state.detail,active=detail?.chat?.active;
  if(document.hidden||chatFollowing||state.tab!=='chat'||!active)return;
  const id=detail.project.id,load=projectLoad;chatFollowing=true;
  try{
    const chat=await api(`/api/projects/${id}/chat`);
    if(load!==projectLoad||state.detail?.project.id!==id)return;
    const turn=chat.turns.find(t=>t.id===active);
    if(chat.active!==active||turn?.status!=='running'){await refreshSelected();return;}
    const saved=state.detail.chat?.turns?.find(t=>t.id===active);if(saved)Object.assign(saved,{draft:turn.draft,note:turn.note});
    const element=document.querySelector(`[data-chat-turn="${CSS.escape(active)}"]`),history=$('#chat-history');if(!element||!history)return;
    const bottom=history.scrollHeight-history.scrollTop-history.clientHeight<40;
    const draft=$('[data-chat-draft]',element),step=$('[data-chat-step]',element);
    if(draft&&draft.dataset.text!==turn.draft){draft.dataset.text=turn.draft;draft.innerHTML=turn.draft?chatText(turn.draft):'';}
    if(step)step.textContent=turn.note||'Working…';
    if(bottom)history.scrollTop=history.scrollHeight;
  }catch{}finally{chatFollowing=false;}
},1000);
function renderSpending(){const s=state.bootstrap?.spending;$('#spending-summary').innerHTML=s?`<div><small>TODAY</small><strong>${money(s.today)}</strong></div><div><small>ALL PROJECTS</small><strong>${money(s.total)}</strong></div><div><small>PENDING</small><strong>${money(s.pending)}</strong></div>`:'';}
function openSettings(){const b=state.bootstrap;renderSpending();api('/api/bootstrap').then(next=>{state.bootstrap=next;renderSpending();}).catch(()=>{});$('#remember-label').hidden=!b.windows;$('#remember-key').checked=Boolean(b.persisted);$('#api-key').value='';renderConnectionNote();$('#key-note').textContent=b.persisted?'Your key is protected for this Windows account.':'Kept in memory for this session. Never included in reports.';$('#settings-error').textContent='';$('#settings-dialog').showModal();}
$('#new-project').addEventListener('click',()=>{
  if($('#project-form')){
    captureNewProjectDraft();
    if(projectDrafts.has('new')&&!confirm('Discard this new project draft? The address, name, and other fields you entered will be cleared.'))return;
    projectDrafts.delete('new');
    newForm({keepDraft:false});
    return;
  }
  newForm();
});$('#open-settings').addEventListener('click',openSettings);$('#settings-top').addEventListener('click',openSettings);
for(const b of document.querySelectorAll('[data-close]'))b.addEventListener('click',()=>document.getElementById(b.dataset.close).close());
let licenseLoaded=false;
$('#open-about').addEventListener('click',()=>{$('#about-version').textContent=state.bootstrap?.version||'—';$('#about-dialog').showModal();});
$('#about-terms').addEventListener('toggle',async()=>{
  if(!$('#about-terms').open||licenseLoaded)return;
  try{const response=await fetch('/license');if(!response.ok)throw new Error('License unavailable.');$('#about-license-text').textContent=await response.text();licenseLoaded=true;}
  catch{$('#about-license-text').textContent='The license could not be loaded. The full terms are in the LICENSE file at https://github.com/Abe-Borg/ahj-atlas.';}
});
$('#settings-form').addEventListener('submit',async e=>{e.preventDefault();const b=$('#save-settings');b.disabled=true;b.textContent='Checking connection…';try{await api('/api/settings',{method:'POST',body:{key:$('#api-key').value.trim(),remember:$('#remember-key').checked}});state.bootstrap=await api('/api/bootstrap');$('#api-key').value='';$('#settings-dialog').close();renderSidebar();toast('Workspace settings saved.');}catch(error){$('#settings-error').textContent=error.message;}finally{b.disabled=false;b.textContent='Save settings';}});
$('#forget-key').addEventListener('click',async()=>{try{await api('/api/connection',{method:'DELETE',body:{}});state.bootstrap=await api('/api/bootstrap');$('#api-key').value='';$('#remember-key').checked=false;renderSidebar();toast('API key disconnected and removed from saved storage.');}catch(e){$('#settings-error').textContent=e.message;}});
async function init(){try{state.bootstrap=await api('/api/bootstrap');if(state.bootstrap.keyStatus==='checking')void refreshConnection(true).catch(()=>{});if(state.bootstrap.updatesEnabled){renderUpdateStatus();void checkUpdates();setInterval(()=>checkUpdates(),60*60*1000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)void checkUpdates();});}await refreshProjects();const id=new URLSearchParams(location.hash.slice(1)).get('project');if(id&&state.projects.some(p=>p.id===id))await selectProject(id);else newForm();}catch(e){$('#main').innerHTML=`<div class="error-panel"><h2>Unable to open the workspace</h2><p>${esc(e.message)}</p><p>Keep the local application running, then reload this page.</p></div>`;}}
init().then(()=>{
  const ctx=document.modelContext;if(!ctx?.registerTool)return;
  const controller=new AbortController();
  for(const tool of [
    {name:'list_research_projects',title:'List AHJ research projects',description:'Read saved project names, disciplines, modes, and research status. Does not start research or spend funds.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,untrustedContentHint:true},execute:async()=>{await refreshProjects();return state.projects.map(p=>({id:p.id,name:p.name,discipline:p.discipline,status:p.status,cost:p.cost}));}},
    {name:'open_research_project',title:'Open an AHJ research project',description:'Open an existing project in the visible workspace. Does not start or resume paid research.',inputSchema:{type:'object',properties:{projectId:{type:'string'}},required:['projectId'],additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:true},execute:async input=>{if(!input||typeof input.projectId!=='string'||!state.projects.some(p=>p.id===input.projectId))throw new Error('Choose an existing project ID.');await selectProject(input.projectId);return {id:state.selected,status:state.detail.project.status};}},
  ])try{Promise.resolve(ctx.registerTool(tool,{signal:controller.signal})).catch(()=>{});}catch{}
  window.addEventListener('pagehide',()=>controller.abort(),{once:true});
});
