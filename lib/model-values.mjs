// Normalize only documented enum values. IDs, prose and unknown values retain
// their exact spelling, and signed provider tool inputs are never mutated.
export const EVIDENCE_STATUSES=['verified','inferred','conflicting','unverified'];
export const ADOPTION_TYPES=['direct','referenced','guidance','unconfirmed'];
export const COVERAGE_VALUES=['supported','unresolved','not_applicable'];
export const APPLICABILITY=['applicable','conditional','not_applicable','unresolved'];
export function normalizeEnum(value,allowed){
  return typeof value==='string'?(allowed.find(v=>v.toLowerCase()===value.toLowerCase())??value):value;
}
export function normalizeCompletion(input){
  if(!input||typeof input!=='object'||Array.isArray(input))return input;
  return {...input,
    ...(input.coverage&&typeof input.coverage==='object'&&!Array.isArray(input.coverage)?{coverage:Object.fromEntries(Object.entries(input.coverage).map(([key,value])=>[key,normalizeEnum(value,COVERAGE_VALUES)]))}:{}),
    ...(Array.isArray(input.standards)?{standards:input.standards.map(row=>row&&typeof row==='object'&&!Array.isArray(row)?{...row,applicability:normalizeEnum(row.applicability,APPLICABILITY)}:row)}:{}),
  };
}
