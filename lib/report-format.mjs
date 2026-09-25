// A single repeated row shape keeps the provider's compiled grammar small.
// Positional fields are decoded and checked locally before evidence validation.
import { normalizeEnum, EVIDENCE_STATUSES, ADOPTION_TYPES, APPLICABILITY } from './model-values.mjs';
export const REPORT_FIELDS={
  jurisdiction:['description','authority','status','notes'],
  authorities:['name','responsibility','website','phone','email','address','status'],
  contacts:['name','title','organization','responsibility','email','phone','address','website','notes','status'],
  codes:['name','edition','authority','adoptionType','adoptionInstrument','effectiveDate','amendments','applicability','notes','status'],
  fireStandards:['name','edition','authority','adoptionType','adoptionInstrument','effectiveDate','amendments','applicability','notes','status','applicabilityStatus','adoptionSourceId','editionSourceId'],
  requirements:['title','authority','details','website','status'],
  gaps:['question','why','contact','nextStep'],
  coverage:['jurisdiction','contacts','codes','process'],
};
const string={type:'string'},object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
export const REPORT_WIRE_SCHEMA=object({summary:string,items:{type:'array',items:object({section:{type:'string',enum:Object.keys(REPORT_FIELDS)},fields:{type:'array',items:string},evidence:{type:'array',items:object({sourceId:string,quote:string,pageOrSection:string})}})}});
export const REPORT_FORMAT_INSTRUCTIONS=`Return the report using summary and items. Each item has section, fields, and evidence. The fields array must contain strings in EXACTLY the order below, with EXACTLY the listed number of fields. Use an empty string for an unknown value; do not omit or shift fields. Create exactly one jurisdiction row and exactly one coverage row. Create one row per authority, contact, code, requirement or gap; omit rows when none are established. Evidence belongs to its own row and contains short exact source quotations. Use an empty evidence array for gaps and coverage. Status values: verified, inferred, conflicting, unverified. Code adoptionType values: direct, referenced, guidance, unconfirmed.\n${Object.entries(REPORT_FIELDS).map(([section,fields])=>`${section} (${fields.length} fields): ${fields.join(' | ')}`).join('\n')}`;
export function encodeReport(report){
  const items=[];
  for(const [section,fields] of Object.entries(REPORT_FIELDS)){
    const rows=['jurisdiction','coverage'].includes(section)?[report[section]]:report[section];
    for(const row of rows||[])items.push({section,fields:fields.map(key=>String(row?.[key]??'')),evidence:['gaps','coverage'].includes(section)?[]:(row.evidence||[]).map(({sourceId,quote,pageOrSection})=>({sourceId,quote,pageOrSection}))});
  }
  return {summary:report.summary,items};
}
export function decodeReport(wire){
  if(!wire||typeof wire.summary!=='string'||!Array.isArray(wire.items)||wire.items.length>3000)throw new Error('The final report did not match its transfer format.');
  const report={summary:wire.summary,authorities:[],contacts:[],codes:[],fireStandards:[],requirements:[],gaps:[]};
  for(const row of wire.items){
    const section=normalizeEnum(row?.section,Object.keys(REPORT_FIELDS));
    const fields=Object.hasOwn(REPORT_FIELDS,section||'')?REPORT_FIELDS[section]:null;
    if(!fields||!Array.isArray(row.fields)||row.fields.length!==fields.length||row.fields.some(v=>typeof v!=='string'))throw new Error('A final-report row had missing or incorrectly ordered fields.');
    if(!Array.isArray(row.evidence)||row.evidence.some(e=>!e||['sourceId','quote','pageOrSection'].some(k=>typeof e[k]!=='string')))throw new Error('A final-report row had invalid evidence references.');
    const item=Object.fromEntries(fields.map((key,i)=>[key,row.fields[i]]));
    if(Object.hasOwn(item,'status')){item.status=normalizeEnum(item.status,EVIDENCE_STATUSES);if(!EVIDENCE_STATUSES.includes(item.status))throw new Error('A final-report row had an invalid evidence status.');}
    if(['codes','fireStandards'].includes(section)){item.adoptionType=normalizeEnum(item.adoptionType,ADOPTION_TYPES);if(!ADOPTION_TYPES.includes(item.adoptionType))throw new Error('A code row had an invalid adoption type.');}
    if(section==='fireStandards')item.applicabilityStatus=normalizeEnum(item.applicabilityStatus,APPLICABILITY);
    if(!['gaps','coverage'].includes(section))item.evidence=row.evidence;
    if(['jurisdiction','coverage'].includes(section)){if(report[section])throw new Error('The final report repeated a single report section.');report[section]=item;}
    else report[section].push(item);
  }
  if(!report.jurisdiction||!report.coverage)throw new Error('The final report omitted jurisdiction or coverage.');
  if(!report.fireStandards.length)delete report.fireStandards;
  return report;
}
