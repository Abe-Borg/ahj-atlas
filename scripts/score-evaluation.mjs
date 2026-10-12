// Scores AHJ Atlas JSON exports against an answer key you checked independently, such as
// editions an AHJ confirmed in writing. Read-only and offline: it sends no requests and
// changes no project. See docs/accuracy-evaluation-2026-10-12.md.
//   node scripts/score-evaluation.mjs <answer-key.json> <export.json | folder>... [--json]
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { standardIds } from '../lib/screening.mjs';

const normalize=value=>String(value??'').normalize('NFC').replace(/\s+/g,' ').trim().toLowerCase();
const list=value=>(Array.isArray(value)?value:[value]).map(normalize).filter(Boolean);
// A term counts as a whole word or phrase, so "NEC" does not match inside "Connecticut".
const mentions=(text,term)=>new RegExp(`(?<![\\p{L}\\p{N}])${term.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}(?![\\p{L}\\p{N}])`,'u').test(normalize(text));
const year=value=>String(value??'').match(/\b(?:19|20)\d{2}\b/)?.[0]||'';
// Editions match by year; an edition with no year ("Eighth Edition") must match as written.
export function sameEdition(a,b){const ya=year(a),yb=year(b);return ya||yb?ya===yb:Boolean(normalize(a))&&normalize(a)===normalize(b);}
export const OUTCOMES={
  incorrect:'Incorrect verified',omission:'Material omission',gap:'Legitimate gap',correct:'Correct',underconfident:'Correct, not established',
};
// One key item against the report rows that name it. Each row agrees, disagrees, is partial
// (the right edition, but applicability left conditional or unresolved) or says nothing. A
// verified row that disagrees is the worst outcome even when another row agrees: a reader
// cannot tell which to trust. A partial row is never correct, verified or not.
function outcome(rows,{isPublic=true,classify}){
  const verified=rows.filter(r=>r.status==='verified').map(classify),all=rows.map(classify);
  if(verified.includes('disagree'))return 'incorrect';
  if(verified.includes('agree'))return 'correct';
  if(all.includes('agree')||all.includes('partial'))return 'underconfident';
  return isPublic?'omission':'gap';
}
const describe=rows=>rows.length?rows.map(r=>[r.name||r.authority||r.description,r.edition&&`edition ${r.edition}`,r.applicabilityStatus,r.status].filter(Boolean).join(' · ')).join('; '):'No finding';
export function scoreRun(item,data){
  const report=data.report||{},results=[],codes=report.codes||[],screened=[...(report.fireStandards||[]),...(report.standards||[])];
  if(item.jurisdiction){
    // The named authority decides; the description may mention the right body while explaining
    // why it does not govern. The description is read only when no authority is named.
    const terms=list(item.jurisdiction.authority),j=report.jurisdiction?[report.jurisdiction]:[];
    const classify=r=>terms.some(t=>mentions(String(r.authority||'').trim()?r.authority:r.description,t))?'agree':'disagree';
    results.push({kind:'Jurisdiction',item:[item.jurisdiction.authority].flat()[0],expected:[item.jurisdiction.authority].flat().join(' / '),found:describe(j),outcome:outcome(j,{isPublic:item.jurisdiction.public!==false,classify})});
  }
  const matched=new Set();
  for(const code of item.codes||[]){
    const terms=list(code.name),rows=codes.filter(r=>terms.some(t=>mentions(r.name,t)));rows.forEach(r=>matched.add(r));
    results.push({kind:'Code',item:[code.name].flat()[0],expected:code.edition,found:describe(rows),outcome:outcome(rows,{isPublic:code.public!==false,classify:r=>sameEdition(r.edition,code.edition)?'agree':'disagree'})});
  }
  for(const standard of item.standards||[]){
    const id=standardIds(standard.standard)[0]||standard.standard,rows=[...screened,...codes].filter(r=>standardIds(r.name)[0]===id);rows.forEach(r=>matched.add(r));
    // A standard that applies agrees only with an applicable row of its edition; the right
    // edition with applicability conditional, unresolved or unstated is partial. A standard the
    // AHJ confirmed does not apply agrees with a not_applicable row and disagrees with an
    // applicable one; a conditional or unresolved row did not establish either.
    const classify=standard.applicable===false?r=>r.applicabilityStatus==='not_applicable'?'agree':r.applicabilityStatus==='applicable'?'disagree':'none'
      :r=>r.applicabilityStatus==='not_applicable'||!sameEdition(r.edition,standard.edition)?'disagree':r.applicabilityStatus==='applicable'?'agree':'partial';
    results.push({kind:'Standard',item:id,expected:standard.applicable===false?'Not applicable':standard.edition,found:describe(rows),outcome:outcome(rows,{isPublic:standard.public!==false,classify})});
  }
  // Verified rows the key does not cover cannot be scored; list them for a manual check.
  const unchecked=[...codes,...screened].filter(r=>r.status==='verified'&&!matched.has(r)).map(r=>[r.name,r.edition].filter(Boolean).join(' · '));
  const count=key=>results.filter(r=>r.outcome===key).length;
  return {project:data.project?.name||'',exportedAt:data.exportedAt||'',mode:data.project?.processingMode||'',status:data.project?.status||'',cost:Number(data.project?.estimatedApiCost)||0,
    questions:(report.gaps||[]).length,results,unchecked,totals:Object.fromEntries(Object.keys(OUTCOMES).map(key=>[key,count(key)])),hasReport:Boolean(data.report)};
}
// Each export joins the first case whose match text appears in its project name or address.
export function scoreEvaluation(key,exports){
  const cases=(key.cases||[]).map(item=>({id:item.id,match:normalize(item.match),item,runs:[]})),unmatched=[];
  for(const {file,data} of exports){
    const found=cases.find(c=>c.match&&[data.project?.name,data.project?.address].some(v=>normalize(v).includes(c.match)));
    if(found)found.runs.push({file,...scoreRun(found.item,data)});else unmatched.push(file);
  }
  return {cases,unmatched};
}
const money=value=>`$${value.toFixed(2)}`,cell=value=>String(value??'').replace(/\|/g,'\\|').replace(/\n/g,' ');
export function markdown({cases,unmatched},keyFile=''){
  const runs=cases.flatMap(c=>c.runs.map((run,i)=>({id:c.id,n:i+1,...run}))),sum=key=>runs.reduce((n,r)=>n+r.totals[key],0);
  const lines=['# Accuracy evaluation','',`Answer key: ${keyFile||'(inline)'} · ${runs.length} export${runs.length===1?'':'s'} scored · ${new Date().toISOString().slice(0,10)}`,'',
    '## Summary','','| Case | Run | Mode | Status | Cost | Incorrect verified | Material omissions | Legitimate gaps | Correct | Correct, not established | Unchecked verified | Questions |','|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...runs.map(r=>`| ${cell(r.id)} | ${r.n} | ${r.mode} | ${r.status} | ${money(r.cost)} | ${r.totals.incorrect} | ${r.totals.omission} | ${r.totals.gap} | ${r.totals.correct} | ${r.totals.underconfident} | ${r.unchecked.length} | ${r.questions} |`),
    `| **Total** | | | | **${money(runs.reduce((n,r)=>n+r.cost,0))}** | **${sum('incorrect')}** | **${sum('omission')}** | **${sum('gap')}** | **${sum('correct')}** | **${sum('underconfident')}** | **${runs.reduce((n,r)=>n+r.unchecked.length,0)}** | |`,''];
  const missing=cases.filter(c=>!c.runs.length).map(c=>c.id);
  if(missing.length)lines.push(`Cases with no export: ${missing.join(', ')}.`,'');
  if(unmatched.length)lines.push(`Exports matching no case: ${unmatched.join(', ')}.`,'');
  for(const r of runs){
    lines.push(`## ${cell(r.id)} · run ${r.n}`,'',`${cell(r.project)} · ${r.file} · exported ${r.exportedAt||'unknown'}${r.hasReport?'':' · **no final report**'}`,'','| Item | Expected | Report | Outcome |','|---|---|---|---|',
      ...r.results.map(x=>`| ${x.kind}: ${cell(x.item)} | ${cell(x.expected)} | ${cell(x.found)} | ${OUTCOMES[x.outcome]} |`),'');
    if(r.unchecked.length)lines.push('Verified findings the key does not cover (check by hand):','',...r.unchecked.map(u=>`- ${cell(u)}`),'');
  }
  return lines.join('\n');
}
function jsonFiles(arg){
  return statSync(arg).isDirectory()?readdirSync(arg).filter(f=>f.toLowerCase().endsWith('.json')).sort().map(f=>path.join(arg,f)):[arg];
}
// Windows paths are case-insensitive, so the drive letter may differ in case.
const samePath=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
if(process.argv[1]&&samePath(path.resolve(process.argv[1]),fileURLToPath(import.meta.url))){
  const args=process.argv.slice(2),json=args.includes('--json'),[keyFile,...rest]=args.filter(a=>a!=='--json');
  if(!keyFile||!rest.length){console.error('Usage: node scripts/score-evaluation.mjs <answer-key.json> <export.json | folder>... [--json]');process.exit(2);}
  const key=JSON.parse(readFileSync(keyFile,'utf8')),files=rest.flatMap(jsonFiles).filter(f=>path.resolve(f)!==path.resolve(keyFile)).map(file=>({file:path.basename(file),data:JSON.parse(readFileSync(file,'utf8'))}));
  // A folder may hold other JSON files, such as a diagnostics export; only project exports are scored.
  for(const f of files)if(f.data?.application!=='AHJ Atlas'||!f.data?.project)console.error(`Skipped ${f.file}: not an AHJ Atlas project export.`);
  const exports=files.filter(f=>f.data?.application==='AHJ Atlas'&&f.data?.project);
  const result=scoreEvaluation(key,exports);
  console.log(json?JSON.stringify(result,null,2):markdown(result,path.basename(keyFile)));
}
