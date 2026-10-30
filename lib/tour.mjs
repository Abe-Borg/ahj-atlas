// The guided tour's practice project (public/tour.js walks the window over it).
//
// The tour runs on one fictional project, Sampleton, built at the start of each tour in a store
// of its own that lives in memory: it is never written to disk, never listed with the user's
// projects, never counted in spending and never seen by the research worker. It is built through
// the production paths — Store.create, Store.source, addDocument, validateReport, Store.saveQuestion,
// proposeAction and applyAction — so its evidence statuses, questions, notes and cards are the
// ones the app's own checks produce. Its two chat replies are a recording, and say so: no model
// was asked. Reading it and exporting it work as for any project; every change to it is refused
// (TOUR_REFUSAL) before anything is read, saved or sent.
import { Store } from './store.mjs';
import { validateReport } from './prompts.mjs';
import { questionContext } from './questions.mjs';
import { addDocument } from './documents.mjs';
import { ResearchTools } from './research-tools.mjs';
import { ProjectChat } from './chat.mjs';
import { proposeAction, applyAction } from './chat-actions.mjs';
import { projectExport } from './exports.mjs';
import { attachmentDisposition } from './download-filename.mjs';

export const TOUR_REFUSAL='This is the guided tour’s practice project: nothing here is saved or sent to Claude, and nothing is spent. End the tour to work on your own projects.';
const FICTIONAL='FICTIONAL EXAMPLE FOR THE AHJ ATLAS GUIDED TOUR. Sampleton, Example State, and every name, number and edition below are invented; they describe no real jurisdiction, person or adoption.';
const site=path=>`https://www.example.com/sampleton/${path}`;

export const PRACTICE_INPUT={
  name:'Practice project · Sampleton data center',
  address:'4100 Practice Parkway, Sampleton, Example State 00000',
  country:'United States',discipline:'Fire protection',scope:'New construction',occupancy:'Hyperscale data center',
  permitDate:'2027-03-01',siteDescription:'Lot 7, Sampleton Technology Park (fictional)',
  notes:'Fictional practice project. About 300,000 square feet on two stories: double-interlock preaction sprinklers in the data halls, wet-pipe sprinklers in support spaces, a diesel fire pump, lithium-ion UPS batteries and diesel standby generators with belly tanks.',
  mode:'realtime',
};

const ORDINANCE=`${FICTIONAL}

City of Sampleton Ordinance 2025-31: Adoption of the building and fire codes.

Section 1. The City of Sampleton adopts the International Building Code, 2024 edition, and the International Fire Code, 2024 edition, as the building and fire codes of the City, effective January 1, 2026.

Section 2. The standards referenced in Chapter 80 of the Sampleton Fire Code are adopted at the editions listed there.

Section 3. Chapter 80 is amended as follows: NFPA 13, Standard for the Installation of Sprinkler Systems, 2025 edition.

Section 4. The City does not adopt NFPA 1, Fire Code, or NFPA 101, Life Safety Code.

Section 5. The Sampleton Fire Marshal's Office administers the fire code and reviews fire protection permits within the city limits, including the Sampleton Technology Park. The Sampleton Building Safety Division administers the building code and issues building permits.`;

// Chapter 80's list as the fictional City amended it. NFPA 13's edition is in the ordinance itself.
const CHAPTER_80=[
  ['NFPA 3','Standard for Commissioning of Fire Protection and Life Safety Systems','2024'],
  ['NFPA 4','Standard for Integrated Fire Protection and Life Safety System Testing','2024'],
  ['NFPA 10','Standard for Portable Fire Extinguishers','2022'],
  ['NFPA 14','Standard for the Installation of Standpipe and Hose Systems','2024'],
  ['NFPA 20','Standard for the Installation of Stationary Pumps for Fire Protection','2022'],
  ['NFPA 22','Standard for Water Tanks for Private Fire Protection','2023'],
  ['NFPA 24','Standard for the Installation of Private Fire Service Mains and Their Appurtenances','2022'],
  ['NFPA 25','Standard for the Inspection, Testing, and Maintenance of Water-Based Fire Protection Systems','2023'],
  ['NFPA 30','Flammable and Combustible Liquids Code','2024'],
  ['NFPA 37','Standard for the Installation and Use of Stationary Combustion Engines and Gas Turbines','2021'],
  ['NFPA 70','National Electrical Code','2023'],
  ['NFPA 72','National Fire Alarm and Signaling Code','2022'],
  ['NFPA 80','Standard for Fire Doors and Other Opening Protectives','2022'],
  ['NFPA 110','Standard for Emergency and Standby Power Systems','2022'],
  ['NFPA 111','Standard on Stored Electrical Energy Emergency and Standby Power Systems','2022'],
  ['NFPA 855','Standard for the Installation of Stationary Energy Storage Systems','2023'],
  ['NFPA 2001','Standard on Clean Agent Fire Extinguishing Systems','2022'],
];
const chapterLine=([standard,title,edition])=>`${standard}, ${title}, ${edition} edition.`;
const REFERENCED=`${FICTIONAL}

Sampleton Fire Code, Chapter 80: Referenced standards, as amended by Ordinance 2025-31.
${CHAPTER_80.map(chapterLine).join('\n')}
NFPA 13, Standard for the Installation of Sprinkler Systems: see Ordinance 2025-31, Section 3.`;

const FIRE_MARSHAL=`${FICTIONAL}

Sampleton Fire Marshal's Office: Fire protection plan review. The Fire Marshal's Office reviews fire sprinkler, fire alarm, fire pump and underground fire service permits in the City of Sampleton. Submit plans through the Sampleton ePlans portal. A pre-submittal meeting is required for buildings over 100,000 square feet. Fire protection plan review: Deputy Fire Marshal Jordan Rivera, fireplans@example.com, telephone 555-0142. Office: 200 Civic Center Way, Sampleton.`;

const BUILDING=`${FICTIONAL}

Sampleton Building Safety Division: Building permits. The Building Safety Division issues building permits and coordinates plan review with the Fire Marshal's Office. Projects over 50,000 square feet require a pre-submittal meeting. Building Official: Casey Morgan, buildingsafety@example.com, telephone 555-0130. Office: 200 Civic Center Way, Sampleton.`;

export const OWNER_DOCUMENT={name:'Owner fire protection standard (fictional).txt',text:`${FICTIONAL} It stands in for a document you add yourself.

Owner Fire Protection Standard, Revision 4. Data halls: double-interlock preaction sprinkler systems. Support spaces: wet-pipe sprinkler systems. Clean-agent systems are not used in this phase. Information technology rooms follow NFPA 75, Standard for the Fire Protection of Information Technology Equipment, 2024 edition. Lithium-ion UPS battery rooms require a hazard mitigation analysis before design development.`};

const BRIEFS={
  jurisdiction:'Fictional practice brief. The site, Lot 7 of the Sampleton Technology Park, is inside the City of Sampleton. Ordinance 2025-31 names the Fire Marshal\'s Office and the Building Safety Division as the reviewing offices.',
  contacts:'Fictional practice brief. Fire protection plans go to Deputy Fire Marshal Jordan Rivera; building permits to Building Official Casey Morgan. The two City pages give different pre-submittal meeting thresholds.',
  codes:'Fictional practice brief. The City adopted the 2024 International Building and Fire Codes effective January 1, 2026, and the Chapter 80 standards at their listed editions; Section 3 of the ordinance adopts NFPA 13, 2025 edition.',
  verification:'Fictional practice brief. Every quotation was matched to the saved source text. The pre-submittal threshold conflicts between two City pages and stays a question.',
  review:'Fictional practice brief. The final report was assembled from the bundled records above.',
};

const quote=(sourceId,text,pageOrSection='')=>({sourceId,quote:text,pageOrSection});
const ADOPTED=quote('S1','The standards referenced in Chapter 80 of the Sampleton Fire Code are adopted at the editions listed there.','Section 2');
const NOT_ADOPTED=quote('S1','The City does not adopt NFPA 1, Fire Code, or NFPA 101, Life Safety Code.','Section 4');
// What each screened standard means for this fictional building. Conditional rows stay
// questions: their edition is adopted, but whether the building triggers them is not settled.
const APPLICABILITY={
  'NFPA 3':['applicable','The owner requires commissioning of every fire protection system.'],
  'NFPA 4':['applicable','Integrated testing of the sprinkler, alarm and pump systems before occupancy.'],
  'NFPA 10':['applicable','Portable extinguishers throughout.'],
  'NFPA 14':['applicable','Standpipes in both stair enclosures.'],
  'NFPA 20':['applicable','A diesel fire pump serves the sprinkler systems.'],
  'NFPA 22':['conditional','Applies only if the water supply study calls for a suction tank.'],
  'NFPA 24':['applicable','A private fire service main loops the building.'],
  'NFPA 25':['applicable','Inspection, testing and maintenance once the systems are in service.'],
  'NFPA 30':['conditional','Depends on the generator belly tanks\' total diesel capacity.'],
  'NFPA 37':['applicable','Diesel standby generators are installed.'],
  'NFPA 70':['applicable','Fire pump and fire alarm wiring.'],
  'NFPA 72':['applicable','Building fire alarm and early warning detection in the data halls.'],
  'NFPA 80':['applicable','Rated doors in the fire barriers around the UPS and generator rooms.'],
  'NFPA 110':['applicable','Standby generators back up the fire pump controller and fire alarm.'],
  'NFPA 111':['conditional','Depends on whether the UPS batteries serve emergency or standby loads.'],
  'NFPA 855':['conditional','Depends on the lithium-ion UPS batteries\' aggregate energy.'],
  'NFPA 2001':['conditional','Applies only if a clean-agent system is added in a later phase.'],
};
function fireStandards(){
  const rows=[{name:'NFPA 13 — Standard for the Installation of Sprinkler Systems',edition:'2025',authority:'City of Sampleton (fictional)',adoptionType:'referenced',adoptionInstrument:'Ordinance 2025-31, Section 3 (local amendment to Chapter 80)',effectiveDate:'2026-01-01',amendments:'Section 3 replaces the edition the International Fire Code lists.',applicability:'Preaction sprinklers in the data halls and wet-pipe sprinklers in the support spaces.',notes:'',status:'verified',applicabilityStatus:'applicable',adoptionSourceId:'S1',editionSourceId:'S1',evidence:[ADOPTED,quote('S1','Section 3. Chapter 80 is amended as follows: NFPA 13, Standard for the Installation of Sprinkler Systems, 2025 edition.','Section 3')]}];
  rows.push(...CHAPTER_80.map(([standard,title,edition])=>{
    const [applicabilityStatus,applicability]=APPLICABILITY[standard];
    return {name:`${standard} — ${title}`,edition,authority:'City of Sampleton (fictional)',adoptionType:'referenced',adoptionInstrument:'Ordinance 2025-31, Section 2 (Chapter 80)',effectiveDate:'2026-01-01',amendments:'None found',applicability,notes:'',status:'verified',applicabilityStatus,adoptionSourceId:'S1',editionSourceId:'S2',evidence:[ADOPTED,quote('S2',chapterLine([standard,title,edition]),'Chapter 80')]};
  }));
  for(const [standard,title] of [['NFPA 1','Fire Code'],['NFPA 101','Life Safety Code']])
    rows.push({name:`${standard} — ${title}`,edition:'',authority:'City of Sampleton (fictional)',adoptionType:'unconfirmed',adoptionInstrument:'',effectiveDate:'',amendments:'',applicability:'The City adopts the International Fire Code and does not adopt this standard.',notes:'',status:'verified',applicabilityStatus:'not_applicable',adoptionSourceId:'S1',editionSourceId:'',evidence:[NOT_ADOPTED]});
  rows.push({name:'NFPA 75 — Standard for the Fire Protection of Information Technology Equipment',edition:'2024',authority:'Owner fire protection standard (fictional)',adoptionType:'guidance',adoptionInstrument:'Owner fire protection standard, Revision 4',effectiveDate:'',amendments:'',applicability:'The owner\'s standard requires it in the information technology rooms; the City does not list it.',notes:'An owner requirement, not a City adoption.',status:'inferred',applicabilityStatus:'conditional',adoptionSourceId:'',editionSourceId:'S6',evidence:[quote('S6','Information technology rooms follow NFPA 75, Standard for the Fire Protection of Information Technology Equipment, 2024 edition.','Revision 4')]});
  return rows;
}

const MARSHAL_REVIEWS=quote('S3','The Fire Marshal\'s Office reviews fire sprinkler, fire alarm, fire pump and underground fire service permits in the City of Sampleton.');
const PRESUBMITTAL='Which pre-submittal meeting threshold does the City apply: 100,000 or 50,000 square feet?';
function report(){
  const codesAdopted=quote('S1','The City of Sampleton adopts the International Building Code, 2024 edition, and the International Fire Code, 2024 edition, as the building and fire codes of the City, effective January 1, 2026.','Section 1');
  const code=(name,adoptionInstrument,applicability)=>({name,edition:'2024',authority:'City of Sampleton (fictional)',adoptionType:'direct',adoptionInstrument,effectiveDate:'2026-01-01',amendments:'Chapter 80 amended for NFPA 13 (Section 3).',applicability,notes:'',status:'verified',evidence:[codesAdopted]});
  return {
    summary:'This is a fictional practice project for the guided tour: no real place, person or adoption is described. The City of Sampleton reviews this new hyperscale data center. Its Building Safety Division issues the building permit and its Fire Marshal\'s Office reviews the fire protection permits. The City adopted the 2024 International Building and Fire Codes effective January 1, 2026, with a local amendment that adopts NFPA 13, 2025 edition. Whether the batteries, generator fuel and water supply trigger NFPA 855, NFPA 30 and NFPA 22 is still open, and two City pages disagree on the pre-submittal meeting threshold.',
    jurisdiction:{authority:'City of Sampleton (fictional)',description:'The site, Lot 7 of the Sampleton Technology Park, is inside the city limits. The City reviews both the building and the fire protection permits.',status:'verified',notes:'Fictional practice record.',evidence:[quote('S1','The Sampleton Fire Marshal\'s Office administers the fire code and reviews fire protection permits within the city limits, including the Sampleton Technology Park.','Section 5')]},
    authorities:[
      {name:'Sampleton Fire Marshal\'s Office',responsibility:'Fire protection plan review and permits: sprinklers, fire alarm, fire pump and underground fire service.',website:site('fire-marshal'),phone:'555-0142',email:'fireplans@example.com',address:'200 Civic Center Way, Sampleton',status:'verified',evidence:[MARSHAL_REVIEWS,quote('S3','Fire protection plan review: Deputy Fire Marshal Jordan Rivera, fireplans@example.com, telephone 555-0142.')]},
      {name:'Sampleton Building Safety Division',responsibility:'Building permits, coordinated with the Fire Marshal\'s plan review.',website:site('building-safety'),phone:'555-0130',email:'buildingsafety@example.com',address:'200 Civic Center Way, Sampleton',status:'verified',evidence:[quote('S4','The Building Safety Division issues building permits and coordinates plan review with the Fire Marshal\'s Office.'),quote('S4','Building Official: Casey Morgan, buildingsafety@example.com, telephone 555-0130.')]},
      {name:'Example State Fire Marshal',responsibility:'May license the fire protection contractors. Found in a search and not read: confirm before relying on it.',website:'',phone:'',email:'',address:'',status:'inferred',evidence:[]},
    ],
    contacts:[
      {name:'Jordan Rivera',title:'Deputy Fire Marshal, fire protection plan review',organization:'Sampleton Fire Marshal\'s Office',responsibility:'Fire sprinkler, fire alarm and fire pump plans.',email:'fireplans@example.com',phone:'555-0142',address:'200 Civic Center Way, Sampleton',website:site('fire-marshal'),notes:'A fictional person.',status:'verified',evidence:[quote('S3','Fire protection plan review: Deputy Fire Marshal Jordan Rivera, fireplans@example.com, telephone 555-0142.')]},
      {name:'Casey Morgan',title:'Building Official',organization:'Sampleton Building Safety Division',responsibility:'Building permits and the building plan review.',email:'buildingsafety@example.com',phone:'555-0130',address:'200 Civic Center Way, Sampleton',website:site('building-safety'),notes:'A fictional person.',status:'verified',evidence:[quote('S4','Building Official: Casey Morgan, buildingsafety@example.com, telephone 555-0130.')]},
    ],
    codes:[code('International Building Code','Ordinance 2025-31, Section 1','The building code for the project.'),code('International Fire Code','Ordinance 2025-31, Section 1','The fire code; its Chapter 80 lists the referenced NFPA editions.')],
    fireStandards:fireStandards(),
    requirements:[
      {title:'Fire protection permits and plan review',authority:'Sampleton Fire Marshal\'s Office',details:'Separate permits for the sprinklers, fire alarm, fire pump and underground fire service main, submitted through the Sampleton ePlans portal.',website:site('fire-marshal'),status:'verified',evidence:[MARSHAL_REVIEWS]},
      {title:'Pre-submittal meeting',authority:'City of Sampleton (fictional)',details:'Both City pages require one for a building this size, but they give different thresholds.',website:site('fire-marshal'),status:'conflicting',evidence:[quote('S3','A pre-submittal meeting is required for buildings over 100,000 square feet.'),quote('S4','Projects over 50,000 square feet require a pre-submittal meeting.')]},
      {title:'Building permit',authority:'Sampleton Building Safety Division',details:'Issued by the Building Safety Division after the coordinated plan review.',website:site('building-safety'),status:'verified',evidence:[quote('S4','The Building Safety Division issues building permits and coordinates plan review with the Fire Marshal\'s Office.')]},
    ],
    gaps:[{question:PRESUBMITTAL,why:'The Fire Marshal\'s page and the Building Safety page give different thresholds.',contact:'Sampleton Fire Marshal\'s Office',nextStep:'Ask the Fire Marshal\'s Office which threshold applies and whether one meeting covers both reviews.'}],
    coverage:{jurisdiction:'Source-supported: the adopting ordinance names the city limits and the Technology Park.',contacts:'Two named reviewers, each listed on the City page that names them.',process:'Permits and plan review are source-supported; the pre-submittal threshold conflicts between two City pages.'},
  };
}

const NFPA13_ANSWER=[
  {text:'The City adopts NFPA 13, **2025 edition**, through a local amendment: Section 3 of Ordinance 2025-31 replaces the edition the International Fire Code lists in Chapter 80.',citations:[{sourceId:'S1',quote:'Section 3. Chapter 80 is amended as follows: NFPA 13, Standard for the Installation of Sprinkler Systems, 2025 edition.'}]},
  {text:' The other water-based standards come from the Chapter 80 list, which Section 2 adopts at the editions listed there.',citations:[{sourceId:'S1',quote:'The standards referenced in Chapter 80 of the Sampleton Fire Code are adopted at the editions listed there.'}]},
  {text:'\n\n| Standard | Adopted edition | Adopted by |\n|---|---|---|\n| NFPA 13 | 2025 | Ordinance 2025-31, Section 3 |\n| NFPA 20 | 2022 | Chapter 80, through Section 2 |\n| NFPA 24 | 2022 | Chapter 80, through Section 2 |\n| NFPA 25 | 2023 | Chapter 80, through Section 2 |\n\nThe ordinance takes effect January 1, 2026, before your expected permit date of March 1, 2027. I saved nothing: the card below would add this to the report as a note if you apply it.',citations:[]},
];
const PRESUBMITTAL_ANSWER=[
  {text:'A meeting is required either way, but the City\'s two pages disagree on the threshold. The Fire Marshal\'s Office says buildings over 100,000 square feet',citations:[{sourceId:'S3',quote:'A pre-submittal meeting is required for buildings over 100,000 square feet.'}]},
  {text:', and the Building Safety Division says projects over 50,000 square feet.',citations:[{sourceId:'S4',quote:'Projects over 50,000 square feet require a pre-submittal meeting.'}]},
  {text:' At about 300,000 square feet this building is over both. Ask the Fire Marshal\'s Office whether one meeting covers both reviews. The card below would save that as your answer to the open question; nothing changes until you apply it.',citations:[]},
];

// Builds the practice project in an empty store and returns its ID.
export async function buildPracticeProject(store){
  const p=store.create(PRACTICE_INPUT),id=p.id;
  store.source(id,{url:site('ordinance-2025-31'),title:'City of Sampleton Ordinance 2025-31 (fictional)',text:ORDINANCE,readFull:true,documentDate:'2025-11-18'});
  store.source(id,{url:site('fire-code-chapter-80'),title:'Sampleton Fire Code, Chapter 80 referenced standards (fictional)',text:REFERENCED,readFull:true});
  store.source(id,{url:site('fire-marshal'),title:'Sampleton Fire Marshal\'s Office: Fire protection plan review (fictional)',text:FIRE_MARSHAL,readFull:true});
  store.source(id,{url:site('building-safety'),title:'Sampleton Building Safety Division: Building permits (fictional)',text:BUILDING,readFull:true});
  // A search discovery: listed as a lead, never read as evidence.
  store.source(id,{url:'https://www.example.com/example-state/fire-marshal',title:'Example State Fire Marshal (fictional search result)',text:'',readFull:false});
  const tools=new ResearchTools(store);
  await addDocument(store,tools,id,{name:OWNER_DOCUMENT.name,type:'text/plain',buffer:Buffer.from(OWNER_DOCUMENT.text)});
  for(const stage of store.stages(id))store.updateStage(id,stage.id,{status:'complete',output:BRIEFS[stage.id]||''});
  const project=store.project(id),validated=validateReport(report(),store.sources(id),store.stages(id),[],project.input);
  store.updateProject(id,{status:'complete',note:'',report:validated});
  // Saved answers, then the research context that used them, as after a research round.
  const question=text=>store.project(id).questions.find(q=>q.question===text);
  store.saveQuestion(id,{questionId:question('Confirm NFPA 2001: applicability and adopted edition.').id,status:'answered',answer:'No clean-agent systems in this phase: the owner\'s standard uses double-interlock preaction sprinklers in the data halls.'});
  store.saveQuestion(id,{questionId:question('Confirm NFPA 111: applicability and adopted edition.').id,status:'dismissed',reason:'Not a priority until the UPS vendor is chosen.'});
  store.updateProject(id,{input:{...store.project(id).input,questionResponses:questionContext(store.questionResponses(id))}});
  // Two recorded replies: one note card already applied, one answer card waiting.
  const sources=store.sources(id),turn=(clientId,message,mode,parts)=>{
    const t=store.createChatTurn(id,{clientId,message,mode});
    const answerParts=parts.map(part=>({text:part.text,citations:part.citations.map(c=>({...c,title:sources.find(s=>s.id===c.sourceId).title}))}));
    store.updateChatTurn(id,t.id,{status:'complete',answer:answerParts.map(part=>part.text).join(''),answer_parts:answerParts});
    return t.id;
  };
  const first=turn('tour-nfpa-13','Which NFPA 13 edition applies to this data center, and where does it come from?','standard',NFPA13_ANSWER);
  proposeAction(store,id,first,'propose_report_note',{title:'NFPA 13 edition',note:'NFPA 13, 2025 edition applies: Ordinance 2025-31, Section 3 amends the Chapter 80 list [S1].',reason:'The ordinance settles the edition and how it is adopted.'});
  await applyAction({store},id,{turnId:first,proposalId:store.chatTurns(id).find(t=>t.id===first).proposals[0].id});
  const second=turn('tour-presubmittal','Is a pre-submittal meeting required, and what threshold applies?','opus',PRESUBMITTAL_ANSWER);
  proposeAction(store,id,second,'propose_question_update',{questionId:question(PRESUBMITTAL).id,status:'answered',answer:'Required either way: at about 300,000 square feet the building is over both thresholds [S3] [S4]. Confirm with the Fire Marshal\'s Office whether one meeting covers both reviews.',reason:'Both City pages require the meeting for this building; only the threshold differs.'});
  store.event(id,'info','Practice project built for the guided tour from bundled fictional records. No research or chat request was made, and nothing was spent.');
  return id;
}

// One practice project per tour, in memory. start() is idempotent while a tour runs, so a
// reload or a second tab picks up the same project; end() discards it.
export class Tour{
  constructor(){this.state=null;this.starting=null;}
  owns(projectId){return Boolean(this.state)&&this.state.projectId===projectId;}
  status(){return {active:Boolean(this.state),projectId:this.state?.projectId||null};}
  async start(){
    if(this.state)return this.status();
    this.starting??=(async()=>{
      const store=new Store(':memory:');
      try{const projectId=await buildPracticeProject(store);this.state={store,projectId,chat:new ProjectChat(store,null,()=>'',{})};}
      catch(error){store.close();throw error;}
    })().finally(()=>{this.starting=null;});
    await this.starting;return this.status();
  }
  end(projectId){
    if(!this.state||(projectId&&projectId!==this.state.projectId))return this.status();
    const {store}=this.state;this.state=null;store.close();return this.status();
  }
  // GET requests for the practice project, answered from its own store in the shapes the
  // ordinary project routes use (detail is server.mjs's projectDetail). Anything else never
  // reaches here: the server refuses it.
  async route({url,res,send,detail}){
    const {store,projectId,chat}=this.state,rest=url.pathname.slice(`/api/projects/${projectId}`.length);
    if(rest==='')return send(res,200,detail(store,chat,projectId));
    if(rest==='/chat')return send(res,200,chat.view(projectId,{before:url.searchParams.get('before')||undefined}));
    if(rest==='/export'){
      const {content,type,filename}=await projectExport(store,projectId,url.searchParams.get('format')||'pdf');
      res.writeHead(200,{'Content-Type':type,'Content-Disposition':attachmentDisposition(filename),'Content-Length':content.length});res.end(content);return;
    }
    if(/^\/images\/[a-f0-9]{16}$/.test(rest))return send(res,404,{error:'Image not found.'});
    return send(res,404,{error:'This action is unavailable.'});
  }
}
