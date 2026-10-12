// Research targets, not an adoption list. Editions must come from project evidence.
// The checklist gate and report validation shared with other disciplines are in screening.mjs.
import { normalizeCompletion } from './model-values.mjs';
import { countryName } from '../public/location.js';
export { APPLICABILITY } from './model-values.mjs';
export const FIRE_PROFILE_VERSION=1;
export function isFireProtection(input={}){return /\bfire[\s-]*(?:protection|suppression|safety|alarm)\b|\bsprinkler\b|^fpe$/i.test(input.discipline||'');}
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
export function individualStandard(value){return nfpaIds(value).length===1&&/^NFPA\b/i.test(String(value||'').trim())&&!/\bNFPA\s*[-–]?\s*\d{1,4}[A-Z]?\s*(?:,|\/|&|\band\b|\bor\b)\s*(?:NFPA\s*)?\d{1,4}(?!\d)/i.test(value);}
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
${review?`Put individual NFPA rows in fireStandards, not codes. Use the exact NFPA designation at the start of name. fireStandards uses the codes fields plus applicabilityStatus, adoptionSourceId and editionSourceId. For a source-supported applicable/conditional edition, cite BOTH the legal adoption chain (adoptionSourceId) and the standard's designation with its edition (editionSourceId); they may be the same source if it proves both. Both IDs must identify evidence quotations in this row, and the adoption-chain quotation must itself say the standard or its parent code is adopted or in force (for example adopts, incorporated by reference, in force, or effective on a stated date); a catalog listing or a published standard's own effective date does not. Keep unrelated standards and governing model codes in codes. Include every screening target, even if unresolved or not_applicable, with the concrete reason and next step in applicability/notes. A missing edition stays blank. Do not label the whole codes area supported while relevant editions remain unresolved.`:`When finishing, include standards: one check per target, plus relevant discoveries. Each check has standard (one designation only, such as NFPA 13 or CAN/ULC-S524), applicability (applicable/conditional/not_applicable/unresolved), and finding (edition and source IDs/adoption chain, or the specific missing evidence/scope and next step). Preserve these details in the brief. Mark codes unresolved when any relevant edition/adoption chain is unverified; naming a code framework is not completion of NFPA research.`}`;
}
// A checklist row names one standard. CAN/ULC, CSA, UL and FM rows are valid
// discoveries (Canadian codes reference them alongside NFPA). A labelled NFPA
// row such as "NFPA 13 – Sprinkler systems" counts as NFPA 13; the brief keeps
// its label. Grouped or mixed rows never count: after the leading publisher
// (CAN/ULC keeps its slash), a list separator followed by another publisher or
// document number ("/ CSA C282", "/S537", " and UL 9540A") starts a second
// designation. A year after a separator is an edition, not a document.
export const PUBLISHER=/^[A-Z][A-Z0-9&.]+(?:\/[A-Z][A-Z0-9&.]*)*/;
export const ANOTHER=/(?:\/|,|;|&|\+|\band\b|\bor\b)\s*(?:[A-Z][A-Z0-9&.]+(?:\/[A-Z][A-Z0-9&.]*)*[\s-]+)?(?!(?:19|20)\d\d\b)[A-Z]{0,4}\d/;
export function checklistStandard(value){
  const text=String(value??'').trim(),ids=nfpaIds(text),rest=text.slice(text.match(PUBLISHER)?.[0].length||0),grouped=ANOTHER.test(rest);
  if(ids.length===1&&individualStandard(text)&&!grouped)return {standard:ids[0],label:text===ids[0]?'':text};
  if(ids.length||grouped)return {error:'one designation per row'};
  if(text.length>160||!PUBLISHER.test(text)||!/^[^|\n]{0,40}?\d/.test(rest))return {error:'a designation such as NFPA 13 or CAN/ULC-S524'};
  return {standard:text,label:''};
}
export function completionBrief(input){input=normalizeCompletion(input);return String(input.brief)+(Array.isArray(input.standards)?'\n\nSTANDARDS CHECKLIST\n'+input.standards.map(c=>{const {standard,label}=checklistStandard(c.standard);return `${standard||c.standard} | ${c.applicability} | ${label?`Listed as "${label}". `:''}${c.finding}`;}).join('\n'):'');}

// An exact quote match alone does not establish that a quoted year belongs to
// this standard. Require the designation and edition together, and an explicit
// adoption-source link. This is a conservative guard, not legal interpretation.
export function nfpaEdition(quote,standard,edition,nfpaTable=false){
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
