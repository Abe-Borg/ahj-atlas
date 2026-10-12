import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,writeFileSync,readFileSync,mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { sameEdition,scoreRun,scoreEvaluation,markdown } from '../scripts/score-evaluation.mjs';

const key={cases:[{id:'case-a',match:'Case A',jurisdiction:{authority:['Example County']},
  codes:[{name:['Example Building Code'],edition:'2021'},{name:['Example Fire Code'],edition:'2021'},{name:['NEC'],edition:'2020'}],
  standards:[{standard:'NFPA 13',edition:'2019'},{standard:'NFPA 72',edition:'2019'},{standard:'NFPA 20',edition:'2019',public:false},{standard:'NFPA 2001',applicable:false},{standard:'NFPA 25',edition:'2020'},{standard:'NFPA 14',edition:'2019'}]}]};
const row=(name,edition,status,extra={})=>({name,edition,status,...extra});
// One synthetic export that produces every outcome once or more.
const exported=(name='Case A · run 1',changes={})=>({application:'AHJ Atlas',exportedAt:'2026-10-12T00:00:00.000Z',project:{name,address:'100 Test Avenue',processingMode:'batch',status:'complete',estimatedApiCost:2.5},report:{
  jurisdiction:{authority:'Example County',description:'Unincorporated Example County.',status:'verified'},
  codes:[row('Example Building Code','2021','verified'),row('Example Fire Code','2018','verified'),row('Connecticut State Building Code','2022','verified')],
  fireStandards:[row('NFPA 13 — Sprinkler systems','2019','verified',{applicabilityStatus:'applicable'}),row('NFPA 72 — Fire alarm','2019','unverified',{applicabilityStatus:'unresolved'}),
    row('NFPA 20 — Fire pumps','','unverified',{applicabilityStatus:'unresolved'}),row('NFPA 2001 — Clean agent','','verified',{applicabilityStatus:'not_applicable'}),
    row('NFPA 25 — ITM','','unverified',{applicabilityStatus:'unresolved'}),row('NFPA 14 — Standpipes','2019','verified',{applicabilityStatus:'applicable'}),row('NFPA 14 — Standpipes','2016','verified',{applicabilityStatus:'applicable'})],
  gaps:[{question:'Confirm NFPA 72'},{question:'Confirm NFPA 25'}],...changes}});

test('editions match by year, and a yearless edition must match as written',()=>{
  assert.ok(sameEdition('2019','2019 edition'));assert.ok(sameEdition('NFPA 13-2019','2019'));assert.ok(!sameEdition('2019','2022'));
  assert.ok(sameEdition('Eighth Edition','eighth  edition'));assert.ok(!sameEdition('','2019'));assert.ok(!sameEdition('',''));
});
test('each key item gets one outcome, and a verified disagreement outranks an agreeing row',()=>{
  const run=scoreRun(key.cases[0],exported()),by=item=>run.results.find(r=>r.item===item).outcome;
  assert.equal(by('Example County'),'correct');
  assert.equal(by('Example Building Code'),'correct');
  assert.equal(by('Example Fire Code'),'incorrect');
  // "NEC" is a whole word: the Connecticut code row is not the electrical code.
  assert.equal(by('NEC'),'omission');
  assert.equal(by('NFPA 13'),'correct');
  assert.equal(by('NFPA 72'),'underconfident');
  assert.equal(by('NFPA 20'),'gap');
  assert.equal(by('NFPA 2001'),'correct');
  assert.equal(by('NFPA 25'),'omission');
  assert.equal(by('NFPA 14'),'incorrect');
  assert.deepEqual(run.totals,{incorrect:2,omission:2,gap:1,correct:4,underconfident:1});
  assert.deepEqual(run.unchecked,['Connecticut State Building Code · 2022']);
  assert.equal(run.cost,2.5);assert.equal(run.questions,2);assert.equal(run.mode,'batch');
});
// Codex review: a description naming the right body while another authority governs, and a
// conditional row with the right edition, must not count as correct.
test('the named authority decides the jurisdiction, and a conditional standard is not established',()=>{
  const wrong=exported(),blank=exported();
  wrong.report.jurisdiction={authority:'Town of Other',description:'Example County does not govern this parcel.',status:'verified'};
  blank.report.jurisdiction={authority:'',description:'Unincorporated Example County.',status:'verified'};
  assert.equal(scoreRun(key.cases[0],wrong).results.find(r=>r.kind==='Jurisdiction').outcome,'incorrect');
  assert.equal(scoreRun(key.cases[0],blank).results.find(r=>r.kind==='Jurisdiction').outcome,'correct');
  const conditional=exported();conditional.report.fireStandards[0]={...conditional.report.fireStandards[0],applicabilityStatus:'conditional'};
  assert.equal(scoreRun(key.cases[0],conditional).results.find(r=>r.item==='NFPA 13').outcome,'underconfident');
  const excluded=exported();excluded.report.fireStandards[0]={...excluded.report.fireStandards[0],edition:'',applicabilityStatus:'not_applicable'};
  assert.equal(scoreRun(key.cases[0],excluded).results.find(r=>r.item==='NFPA 13').outcome,'incorrect');
  const undecided=exported();undecided.report.fireStandards[3]={...undecided.report.fireStandards[3],applicabilityStatus:'conditional'};
  assert.equal(scoreRun(key.cases[0],undecided).results.find(r=>r.item==='NFPA 2001').outcome,'omission');
});
test('a not-applicable standard the report calls applicable is an incorrect verified finding',()=>{
  const data=exported();data.report.fireStandards[3]={...data.report.fireStandards[3],edition:'2018',applicabilityStatus:'applicable'};
  assert.equal(scoreRun(key.cases[0],data).results.find(r=>r.item==='NFPA 2001').outcome,'incorrect');
  // With no report at all, every public item is an omission and the run is flagged.
  const empty=scoreRun(key.cases[0],{...exported(),report:null});
  assert.equal(empty.hasReport,false);assert.equal(empty.totals.omission,9);assert.equal(empty.totals.gap,1);
});
test('exports join cases by name or address, and the summary lists runs, totals and gaps in coverage',()=>{
  const twoCases={cases:[...key.cases,{id:'case-b',match:'200 Other Road',standards:[{standard:'NFPA 13',edition:'2022'}]}]};
  const result=scoreEvaluation(twoCases,[{file:'a1.json',data:exported()},{file:'a2.json',data:exported('Case A · run 2')},{file:'x.json',data:exported('Unrelated project')}]);
  assert.equal(result.cases[0].runs.length,2);assert.equal(result.cases[1].runs.length,0);assert.deepEqual(result.unmatched,['x.json']);
  const text=markdown(result,'answer-key.json');
  assert.match(text,/\| case-a \| 1 \| batch \| complete \| \$2\.50 \| 2 \| 2 \| 1 \| 4 \| 1 \| 1 \| 2 \|/);
  assert.match(text,/\| \*\*Total\*\* \| \| \| \| \*\*\$5\.00\*\* \| \*\*4\*\* \|/);
  assert.match(text,/Cases with no export: case-b\./);assert.match(text,/Exports matching no case: x\.json\./);
  assert.match(text,/\| Standard: NFPA 14 \| 2019 \| NFPA 14 — Standpipes · edition 2019 · applicable · verified; NFPA 14 — Standpipes · edition 2016 · applicable · verified \| Incorrect verified \|/);
});
test('the command line scores a folder of exports, skips other JSON and sends no requests',t=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'ahj-atlas-test-eval-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const exportsDir=path.join(dir,'exports');mkdirSync(exportsDir);
  writeFileSync(path.join(dir,'answer-key.json'),JSON.stringify(key));
  writeFileSync(path.join(exportsDir,'run-1.json'),JSON.stringify(exported()));
  writeFileSync(path.join(exportsDir,'diagnostics.json'),JSON.stringify({application:'AHJ Atlas diagnostics'}));
  const script=path.resolve('scripts/score-evaluation.mjs'),out=execFileSync(process.execPath,[script,path.join(dir,'answer-key.json'),exportsDir],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
  assert.match(out,/^# Accuracy evaluation/);assert.match(out,/1 export scored/);assert.match(out,/## case-a · run 1/);
  const json=JSON.parse(execFileSync(process.execPath,[script,path.join(dir,'answer-key.json'),exportsDir,'--json'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
  assert.equal(json.cases[0].runs[0].totals.incorrect,2);
  // The shipped template is a valid key.
  const template=JSON.parse(readFileSync('docs/accuracy-evaluation-answer-key.example.json','utf8'));
  assert.equal(scoreEvaluation(template,[]).cases[0].id,'case-a');
});
