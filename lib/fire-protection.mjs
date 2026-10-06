// Research targets, not an adoption list. Editions must come from project evidence.
import { APPLICABILITY, normalizeEnum, normalizeCompletion } from './model-values.mjs';
import { isResolvedStatus, resolvedCovers, resolvedQuestionText } from './questions.mjs';
import { countryName } from '../public/location.js';
export { APPLICABILITY } from './model-values.mjs';
export const FIRE_PROFILE_VERSION=1;
export function isFireProtection(input={}){return /\bfire[\s-]*(?:protection|suppression|safety)\b|\bsprinkler\b|^fpe$/i.test(input.discipline||'');}
const core=[
  ['1','Fire code framework'],['10','Portable extinguishers'],['13','Sprinkler systems'],
  ['14','Standpipes and hose systems'],['20','Fire pumps'],['22','Fire protection water tanks'],
  ['24','Private fire service mains'],['25','Water-based systems inspection, testing and maintenance'],
  ['70','Electrical coordination'],['72','Fire alarm and signaling'],['80','Fire doors and opening protectives'],
  ['101','Life safety framework'],['3','Fire protection commissioning'],['4','Integrated systems testing'],
];
const groups=[
  [/data[\s-]*cent(?:er|re)|hyperscale|server|\bIT equipment\b/i,[['75','IT equipment fire protection'],['2001','Clean-agent systems'],['855','Stationary energy storage'],['110','Emergency and standby power'],['111','Stored electrical energy power systems'],['30','Flammable and combustible liquids'],['37','Stationary engines']]],
  [/residen|apartment|dwelling|hotel|lodging/i,[['13R','Low-rise residential sprinklers'],['13D','One- and two-family dwelling sprinklers']]],
  [/smoke control|atrium|high[\s-]*rise/i,[['92','Smoke control'],['105','Smoke doors and opening protectives']]],
  [/clean[\s-]*agent|gaseous suppression/i,[['2001','Clean-agent systems']]],
  [/\bESS\b|\bUPS\b|batter|energy storage/i,[['855','Stationary energy storage'],['111','Stored electrical energy power systems']]],
  [/generator|diesel|fuel|standby power/i,[['110','Emergency and standby power'],['37','Stationary engines'],['30','Flammable and combustible liquids']]],
  [/telecom/i,[['76','Telecommunications facilities']]],
  [/kitchen|restaurant|cooking/i,[['96','Commercial cooking'],['17A','Wet chemical extinguishing systems']]],
  [/foam/i,[['11','Foam systems']]],[/water mist/i,[['750','Water mist systems']]],
  [/water spray/i,[['15','Water spray systems']]],[/carbon dioxide|\bCO2\b/i,[['12','Carbon dioxide systems']]],
  [/propane|\bLPG\b/i,[['58','Liquefied petroleum gas']]],
];
export function nfpaIds(value){return [...new Set([...String(value||'').matchAll(/\bNFPA\s*[-–]?\s*(\d{1,4}(?:[A-Z])?)(?![\w])/gi)].map(m=>'NFPA '+m[1].toUpperCase()))];}
function individualStandard(value){return nfpaIds(value).length===1&&/^NFPA\b/i.test(String(value||'').trim())&&!/\bNFPA\s*[-–]?\s*\d{1,4}[A-Z]?\s*(?:,|\/|&|\band\b|\bor\b)\s*(?:NFPA\s*)?\d{1,4}(?!\d)/i.test(value);}
export function fireProfile(input={}){
  if(!isFireProtection(input))return [];
  const answers=(input.questionResponses||[]).filter(q=>q.status==='answered').map(q=>q.answer);
  const context=[input.scope,input.occupancy,input.notes,...answers].filter(Boolean).join(' '),rows=new Map(core.map(([n,topic])=>['NFPA '+n,{standard:'NFPA '+n,topic,trigger:'Baseline screening; confirm scope and legal applicability.'}]));
  for(const [pattern,items] of groups)if(pattern.test(context))for(const [n,topic] of items)rows.set('NFPA '+n,{standard:'NFPA '+n,topic,trigger:'Screen because of the project use or systems mentioned; presence is not assumed.'});
  for(const standard of nfpaIds(context))if(!rows.has(standard))rows.set(standard,{standard,topic:'Standard mentioned in project context',trigger:'User-specified research target.'});
  return [...rows.values()];
}
export function fireInstructions(input,{review=false}={}){
  const profile=fireProfile(input);if(!profile.length)return '';
  return `\nFIRE PROTECTION COVERAGE (version ${FIRE_PROFILE_VERSION}):\n${profile.map(p=>`${p.standard} | ${p.topic} | ${p.trigger}`).join('\n')}
This is a screening checklist, NOT a list of adopted or necessarily applicable standards. ${review?'Assess every target separately against saved evidence; retain additional relevant standards identified in that evidence.':'Research every target separately; add other standards discovered in authoritative references when relevant.'} Also screen special hazards, storage, suppression type, smoke control and owner/insurer criteria; ask about missing system details. NFPA 1/101 may not be the governing framework. Do not call a standard not_applicable merely because a search found nothing. Missing scope or adoption evidence means conditional or unresolved.
Prioritize the official adoption instrument, amendments, and referenced-standards chapter (for example ${countryName(input.country)==='Canada'?'Division B, Table 1.3.1.2 of the national or provincial building or fire code':'IBC Chapter 35 or IFC Chapter 80'}). ${review?'Check available saved passages for the adoption chain and edition table; record a specific gap where that evidence is missing.':'Read discovered official documents before declaring them unavailable. Efficiently extract multiple edition rows from the same reference table; do not run a separate broad search for every standard. Respect access restrictions and use legitimate official alternatives.'} An amendment booklet may omit unchanged model-code references. Trace those to the incorporated model edition and its reference table; do not infer their years. Check table headers, row labels and footnotes so an adjacent standard or parent-code year is not assigned to the target. A catalog/current-edition page is not adoption evidence. A search snippet or another agent's claim is not evidence.
For EACH standard identify applicability (applicable, conditional, not_applicable or unresolved), exact edition if established, direct/referenced/guidance/unconfirmed basis, parent code AND edition/reference section, adoption authority/instrument, effective date, amendments, relevant short quotations with source IDs, and any system/scope facts needed. Distinguish installation from ongoing inspection/testing, owner preferences from law, and future adoption proposals from the currently effective rules. Never use a grouped entry like 'NFPA 13, 14, 20 and 72' as coverage. Different editions for different legal uses require separate rows and an explanation; do not collapse a conflict.
${review?`Put individual NFPA rows in fireStandards, not codes. Use the exact NFPA designation at the start of name. fireStandards uses the codes fields plus applicabilityStatus, adoptionSourceId and editionSourceId. For a source-supported applicable/conditional edition, cite BOTH the legal adoption chain (adoptionSourceId) and the standard's designation with its edition (editionSourceId); they may be the same source if it proves both. Both IDs must identify evidence quotations in this row. Keep unrelated standards and governing model codes in codes. Include every screening target, even if unresolved or not_applicable, with the concrete reason and next step in applicability/notes. A missing edition stays blank. Do not label the whole codes area supported while relevant editions remain unresolved.`:`When finishing, include standards: one check per target, plus relevant discoveries. Each check has standard (one exact designation), applicability (applicable/conditional/not_applicable/unresolved), and finding (edition and source IDs/adoption chain, or the specific missing evidence/scope and next step). Preserve these details in the brief. Mark codes unresolved when any relevant edition/adoption chain is unverified; naming a code framework is not completion of NFPA research.`}`;
}
export function fireCompletionError(input,projectInput){
  input=normalizeCompletion(input);
  const targets=fireProfile(projectInput);if(!targets.length)return '';
  const checks=input?.standards;
  if(!Array.isArray(checks))return 'Include the standards checklist in finish_research. Every required NFPA target needs a separate finding, even when unresolved.';
  const invalid=checks.some(c=>nfpaIds(c?.standard).length!==1||nfpaIds(c?.standard)[0]!==c.standard||!APPLICABILITY.includes(c?.applicability)||typeof c?.finding!=='string'||c.finding.trim().length<24);
  if(invalid)return 'Each standards check needs one exact NFPA designation, an allowed applicability value, and a substantive finding stating its edition/adoption evidence or the missing fact and next step.';
  const missing=targets.filter(t=>!checks.some(c=>c.standard===t.standard));
  if(missing.length)return 'The NFPA checklist is missing '+missing.map(t=>t.standard).join(', ')+'. Research them or record the specific unresolved question and next step separately.';
  if(checks.some(c=>c.applicability==='unresolved')&&input.coverage?.codes==='supported')return 'NFPA checks remain unresolved. Set codes coverage to unresolved and preserve the specific gaps.';
  return '';
}
export function completionBrief(input){input=normalizeCompletion(input);return String(input.brief)+(Array.isArray(input.standards)?'\n\nNFPA CHECKLIST\n'+input.standards.map(c=>`${c.standard} | ${c.applicability} | ${c.finding}`).join('\n'):'');}

// An exact quote match alone does not establish that a quoted year belongs to
// this standard. Require the designation and edition together, and an explicit
// adoption-source link. This is a conservative guard, not legal interpretation.
function hasEdition(quote,standard,edition,nfpaTable=false){
  const year=String(edition).match(/\b(?:19|20)\d{2}\b/)?.[0];if(!year)return false;
  // Table cells are read as "NFPA | 13-2019" (Canadian referenced-documents tables put the
  // publisher and the number in separate cells) or "NFPA 13 | 2019"; a cell edge counts as a separator.
  quote=String(quote).normalize('NFC');
  const n=standard.slice(5),designation=new RegExp('\\bNFPA\\s*(?:[-–]|\\|)?\\s*'+n+'(?![\\w])','i'),match=designation.exec(quote);
  if(!match){
    // Publisher reference tables often put NFPA in the column heading and
    // use compact rows such as 13-19. The citation must identify that table.
    return nfpaTable&&new RegExp('(?:^|[^\\w])'+n+'\\s*[-–—]\\s*(?:'+year+'|'+year.slice(2)+')\\b','i').test(quote);
  }
  // Stop at the next standard or a parent code, US or Canadian, so its year is not taken for this edition.
  const nearby=quote.slice(match.index,match.index+240),tail=nearby.slice(match[0].length).split(/\bNFPA\s*(?:[-–]|\|)?\s*\d|\b(?:(?:19|20)\d{2}\s*)?(?:IBC|IFC|VCC|USBC|SFPC|International (?:Building|Fire) Code|NBC|NFC|NPC|NECB|OBC|OFC|BCBC|BCFC|CNB|CNPI|National (?:Building|Fire|Plumbing) Code|(?:Ontario|British Columbia|Alberta) (?:Building|Fire) Code|Code (?:national|de construction|de s[ée]curit))\b/i)[0];
  // Adoption lists may place the publication title between designation and year.
  // Exclude ordinance/effective/parent-code dates and stop at other standards.
  const titled=new RegExp('^[\\s,(|]*([A-Za-z][^;\\n\\d|]{1,140}?)\\s*[-–—,(|]\\s*'+year+'\\b','i').exec(tail);
  if(titled&&!/\b(adopt\w*|ordinance|effective|amend\w*|referenc\w*|under|pursuant|dated|resolution|published)\b/i.test(titled[1]))return true;
  // "2019 edition", "edition 2019" and the French "édition 2019".
  return new RegExp('^\\s*(?:[-–—,(|]\\s*)?'+year+'\\b').test(tail)||new RegExp('(?:^|[^\\w])(?:'+year+'\\s+[ée]dition|[ée]dition\\s*[:(]?\\s*'+year+')(?![\\w])','i').test(tail)||new RegExp('^NFPA\\s*(?:[-–]|\\|)?\\s*'+n+'\\s*[-–—]\\s*'+year.slice(2)+'\\b','i').test(nearby);
}
export function validateFireStandards(report,input,validate,stages=[],savedResponses=input?.questionResponses||[]){
  const profile=fireProfile(input);if(!profile.length){delete report.fireStandards;return;}
  for(const stage of stages.filter(s=>['codes','verification'].includes(s.id)))for(const match of String(stage.output||'').matchAll(/^(NFPA \d{1,4}[A-Z]?) \| (?:applicable|conditional|unresolved|not_applicable) \| /gm)){
    if(!profile.some(t=>t.standard===match[1]))profile.push({standard:match[1],topic:'Additional standard identified during research',trigger:'A research-stage checklist identified this standard; retain and verify its finding.'});
  }
  const rows=Array.isArray(report.fireStandards)?report.fireStandards:[];
  // Accept old/simpler model output, but never count a grouped row as coverage.
  report.codes=report.codes.filter(c=>{if(nfpaIds(c.name).length){rows.push(c);return false;}return true;});
  const validated=[];
  for(const row of rows){
    const ids=nfpaIds(row.name);if(!individualStandard(row.name)){const question='Separate the grouped NFPA finding: '+String(row.name||'Unnamed standard');if(!report.gaps.some(g=>g.question===question)&&!resolvedCovers(savedResponses,{question}))report.gaps.push({question,why:'A grouped entry cannot establish individual editions.',contact:row.authority||'Fire protection reviewer',nextStep:'Obtain one edition and adoption chain for each referenced standard.'});continue;}
    row.applicabilityStatus=normalizeEnum(row.applicabilityStatus,APPLICABILITY);
    row.applicabilityStatus=APPLICABILITY.includes(row.applicabilityStatus)?row.applicabilityStatus:'unresolved';
    validate(row,row.applicabilityStatus==='not_applicable'?'Screening':'Code');
    if(row.applicabilityStatus==='not_applicable'&&(!row.applicability?.trim()||!row.evidence.some(e=>e.supported))){row.applicabilityStatus='unresolved';row.notes=(row.notes||'')+' Exclusion needs a documented scope or adoption basis.';}
    const adoption=row.evidence.some(e=>e.supported&&e.sourceId===row.adoptionSourceId);
    const edition=row.evidence.some(e=>e.supported&&e.sourceId===row.editionSourceId&&hasEdition(e.quote,ids[0],row.edition,/NFPA.*(?:table|referenc)|(?:table|referenc).*NFPA/i.test(e.pageOrSection||'')));
    if(row.applicabilityStatus!=='not_applicable'&&(!adoption||!edition||!['direct','referenced'].includes(row.adoptionType)||!row.adoptionInstrument?.trim())){
      if(row.status!=='conflicting')row.status='unverified';
      const reasons=[!adoption?'a supporting adoption-chain quotation is missing':'',!edition?'a matching quotation for this standard and edition is missing':'',!['direct','referenced'].includes(row.adoptionType)?'guidance or unconfirmed adoption does not establish an adopted edition':'',!row.adoptionInstrument?.trim()?'the adoption instrument is unspecified':''].filter(Boolean);
      row.notes=(row.notes||'')+' Adoption evidence check: '+reasons.join('; ')+'.';
    }
    if(row.applicabilityStatus==='unresolved'&&row.status!=='conflicting')row.status='unverified';
    if(report.jurisdiction.status!=='verified'&&row.status==='verified'&&row.applicabilityStatus!=='not_applicable')row.status='inferred';
    validated.push(row);
  }
  for(const target of profile)if(!validated.some(r=>nfpaIds(r.name)[0]===target.standard))validated.push({name:target.standard+' — '+target.topic,edition:'',authority:'Responsible fire protection AHJ',adoptionType:'unconfirmed',adoptionInstrument:'',effectiveDate:'',amendments:'',applicability:'Screening required. '+target.trigger,notes:'This standard was omitted from the final research findings. Confirm its applicability and adopted edition.',status:'unverified',applicabilityStatus:'unresolved',adoptionSourceId:'',editionSourceId:'',evidence:[]});
  const unresolved=validated.filter(r=>r.applicabilityStatus!=='not_applicable'&&(r.status!=='verified'||r.applicabilityStatus!=='applicable'));
  const savedCoversNfpa=(id,question)=>report.gaps.some(g=>nfpaIds(g.question).includes(id))||resolvedCovers(savedResponses,{question})||savedResponses.some(response=>isResolvedStatus(response.status)&&nfpaIds(resolvedQuestionText(response)).includes(id));
  for(const row of unresolved){const id=nfpaIds(row.name)[0];const question=`Confirm ${id}: applicability and adopted edition.`;if(!savedCoversNfpa(id,question))report.gaps.push({question,why:row.notes||row.applicability,contact:row.authority||'Fire protection AHJ',nextStep:'Obtain the reference-table entry, adoption instrument and amendments; confirm any missing system details with the project team.'});}
  report.fireStandards=validated;
  report.fireProtection={profileVersion:FIRE_PROFILE_VERSION,targets:profile.map(t=>t.standard),unresolved:unresolved.length,scopeConditional:validated.filter(r=>r.applicabilityStatus==='conditional').length,applicabilityUnresolved:validated.filter(r=>r.applicabilityStatus==='unresolved').length,evidenceUnresolved:validated.filter(r=>r.applicabilityStatus!=='not_applicable'&&r.status!=='verified').length};
  report.coverage??={};report.coverage.codes=`Fire protection: ${validated.length} individual NFPA findings; ${unresolved.length} need confirmation. Governing-code findings are listed separately.`;
}
