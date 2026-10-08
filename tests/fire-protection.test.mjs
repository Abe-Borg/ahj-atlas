import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import ExcelJS from 'exceljs';
import { fireProfile,isFireProtection,nfpaIds,completionBrief } from '../lib/fire-protection.mjs';
import { CLOSURE_REASON, questionId } from '../lib/questions.mjs';
import { researchPayload,reviewPayload,validateReport,completionError } from '../lib/prompts.mjs';
import { encodeReport,decodeReport,REPORT_WIRE_SCHEMA } from '../lib/report-format.mjs';
import { Store } from '../lib/store.mjs';
import { Engine } from '../lib/engine.mjs';
import { excelReport,pdfReport } from '../lib/exports.mjs';
import { input,report,evidenceText,FakeProvider,fakeTools } from './fixtures.mjs';
const source={id:'S1',url:'https://example.com/adoption',text:evidenceText+' The district adopts NFPA 13, 2019 edition, for sprinkler installations. NFPA 13R, 2016 edition, applies to qualifying residential installations.',read_full:true};
const row=(changes={})=>({name:'NFPA 13 — Sprinkler systems',edition:'2019',authority:'Example District',adoptionType:'direct',adoptionInstrument:'District synthetic adoption instrument',effectiveDate:'',amendments:'Not established',applicability:'Sprinkler installation in the synthetic project.',notes:'Synthetic test only.',status:'verified',applicabilityStatus:'applicable',adoptionSourceId:'S1',editionSourceId:'S1',evidence:[{sourceId:'S1',quote:'The district adopts NFPA 13, 2019 edition, for sprinkler installations.',pageOrSection:'Synthetic adoption provision'}],...changes});
const checked=(rows=[],i=input)=>{const r=report();r.fireStandards=rows;return validateReport(r,[structuredClone(source)],[],[],i);};
function fixture(t){const dir=mkdtempSync(path.join(os.tmpdir(),'ahj-atlas-test-fire-')),store=new Store(dir),provider=new FakeProvider(),engine=new Engine(store,provider,()=>true,{autoStart:false,tools:fakeTools(store)});t.after(async()=>{await engine.close();store.close();assert.ok(path.resolve(dir).startsWith(path.join(os.tmpdir(),'ahj-atlas-test-fire-')));rmSync(dir,{recursive:true,force:true});});return {store,provider,engine};}

test('fire profile recognizes custom specialties, scopes data center systems and never prescribes editions',()=>{
  assert.ok(isFireProtection({discipline:'Fire-protection engineering'}));assert.ok(isFireProtection({discipline:'FPE'}));assert.equal(isFireProtection({discipline:'Electrical'}),false);
  const baseline=fireProfile(input),dc=fireProfile({...input,occupancy:'Hyperscale data center'});
  for(const id of ['NFPA 10','NFPA 13','NFPA 14','NFPA 20','NFPA 22','NFPA 24','NFPA 25','NFPA 72'])assert.ok(baseline.some(t=>t.standard===id));
  for(const id of ['NFPA 75','NFPA 2001','NFPA 855','NFPA 110','NFPA 111','NFPA 30','NFPA 37'])assert.ok(dc.some(t=>t.standard===id));
  assert.ok(!baseline.some(t=>t.standard==='NFPA 13R'));assert.ok(fireProfile({...input,occupancy:'Apartment'}).some(t=>t.standard==='NFPA 13R'));
  assert.ok(fireProfile({...input,notes:'Investigate NFPA 750.'}).some(t=>t.standard==='NFPA 750'));assert.ok(dc.every(t=>!('edition' in t)));assert.ok(fireProfile({...input,notes:'Coordinate NFPA 70E.'}).some(t=>t.standard==='NFPA 70E'));assert.deepEqual(fireProfile({...input,discipline:'Architecture'}),[]);
  assert.deepEqual(nfpaIds('NFPA 13, NFPA 13R, NFPA 13D, NFPA 130'),['NFPA 13','NFPA 13R','NFPA 13D','NFPA 130']);
});
test('completion rejects broad coverage, omitted standards and unsupported completion claims',()=>{
  const done={brief:'The synthetic agency adopts a building code, but standards are not established.',coverage:{jurisdiction:'not_applicable',contacts:'not_applicable',codes:'supported',process:'not_applicable'}};
  assert.match(completionError(done,'codes',input),/checklist/);
  done.standards=fireProfile(input).map(t=>({standard:t.standard,applicability:'unresolved',finding:'No adoption evidence in the synthetic source. Ask for the official reference table.'}));
  assert.match(completionError(done,'codes',input),/coverage to unresolved/);done.coverage.codes='unresolved';assert.equal(completionError(done,'codes',input),'');assert.match(completionBrief(done),/NFPA 72/);
  done.standards=done.standards.filter(t=>t.standard!=='NFPA 13');assert.match(completionError(done,'codes',input),/missing NFPA 13/);
  assert.equal(completionError(done,'codes',{discipline:'Mechanical'}),'');
});
test('completion accepts Canadian and labelled single-standard rows but names grouped rows',()=>{
  const finding='Referenced-documents table not yet read; obtain the edition from the AHJ.';
  const done={brief:'The provincial code references these standards; editions remain unresolved.',coverage:{jurisdiction:'supported',contacts:'unresolved',codes:'unresolved',process:'unresolved'},standards:[...fireProfile(input).map(t=>({standard:t.standard==='NFPA 13'?'NFPA 13 – Sprinkler systems':t.standard,applicability:'unresolved',finding})),{standard:'CAN/ULC-S524',applicability:'conditional',finding},{standard:'CSA C282',applicability:'unresolved',finding}]};
  const original=structuredClone(done);
  assert.equal(completionError(done,'codes',input),'');assert.deepEqual(done,original);
  const brief=completionBrief(done);assert.match(brief,/^NFPA 13 \| unresolved \| Listed as "NFPA 13 – Sprinkler systems"\. /m);assert.match(brief,/^CAN\/ULC-S524 \| conditional \| /m);assert.match(brief,/^CSA C282 \| unresolved \| /m);
  const error=completionError({...done,standards:[...done.standards,{standard:'CAN/ULC-S524 / NFPA 72',applicability:'unresolved',finding},{standard:'NFPA 13, 14 and 20',applicability:'Maybe',finding:'Short.'}]},'codes',input);
  assert.match(error,/"CAN\/ULC-S524 \/ NFPA 72" needs one designation per row/);assert.match(error,/"NFPA 13, 14 and 20" needs one designation per row and an applicability of .* and a substantive finding/);assert.ok(!error.includes('"CSA C282"'));
});
test('NFPA prompts apply to code and verification stages while signed legacy continuations keep their prefix',t=>{
  const {store:s}=fixture(t),p=s.create({...input,occupancy:'Data center'});
  for(const id of ['codes','verification']){const payload=researchPayload(s,p,s.stage(p.id,id));assert.ok(payload.tools.find(t=>t.name==='finish_research').input_schema.properties.standards);assert.match(payload.messages[0].content,/NFPA 855/);}
  assert.ok(!researchPayload(s,p,s.stage(p.id,'contacts')).tools.at(-1).input_schema.properties.standards);
  assert.match(reviewPayload(s,p).system,/adoptionSourceId/);assert.ok(JSON.stringify(REPORT_WIRE_SCHEMA).length<900);
  const original={model:'old-model',system:'Original signed prefix',tools:[{name:'finish_research',input_schema:{properties:{brief:{type:'string'}}}}],messages:[]},a=s.reserve(p.id,'codes',{mode:'realtime',modelKey:'research',payload:original,reserve:100});s.updateAttempt(a.id,{state:'settled'});
  s.updateStage(p.id,'codes',{messages:[{role:'assistant',content:[{type:'redacted_thinking',data:'signature'}]}]});const next=researchPayload(s,p,s.stage(p.id,'codes'));assert.deepEqual(next.tools,original.tools);assert.equal(next.system,original.system);
});
test('missing and grouped NFPA output becomes individual unresolved findings without invented editions',()=>{
  const r=report();r.codes.push(row({name:'NFPA 13, 14, 20 and 72 standards'}));
  const out=validateReport(r,[source],[],[],input);
  assert.equal(out.fireStandards.length,fireProfile(input).length);assert.ok(out.fireStandards.every(r=>r.edition===''&&r.status==='unverified'));assert.equal(out.fireProtection.unresolved,fireProfile(input).length);assert.match(out.coverage.codes,/need confirmation/);
  assert.ok(out.gaps.some(g=>g.question.includes('NFPA 13')));
});
test('edition evidence must match this standard and adoption chain, not parent-code year or a neighboring designation',()=>{
  assert.equal(checked([row()]).fireStandards[0].status,'verified');
  for(const changes of [{edition:'2021'},{adoptionSourceId:'Missing'},{editionSourceId:'Missing'},{adoptionInstrument:''},{adoptionType:'guidance'},{evidence:[{sourceId:'S1',quote:'NFPA 13R, 2016 edition, applies to qualifying residential installations.',pageOrSection:'test'}],edition:'2016'}])assert.equal(checked([row(changes)]).fireStandards[0].status,'unverified');
  const parent=report();parent.fireStandards=[row({edition:'2021',evidence:[{sourceId:'S1',quote:'Use NFPA 13 as referenced by the 2021 International Building Code.',pageOrSection:'Parent code'}]})];assert.equal(validateReport(parent,[{...source,text:source.text+' Use NFPA 13 as referenced by the 2021 International Building Code.'}],[],[],input).fireStandards[0].status,'unverified');
  const conditional=checked([row({applicabilityStatus:'conditional'})]);assert.equal(conditional.fireStandards[0].status,'verified');assert.ok(conditional.gaps.some(g=>g.question.includes('NFPA 13')));
  assert.equal(checked([row({applicabilityStatus:'not_applicable',evidence:[]})]).fireStandards[0].applicabilityStatus,'unresolved');
  const other=checked([row()],{...input,discipline:'Mechanical'});assert.ok(!other.fireStandards);assert.ok(!other.fireProtection);assert.ok(other.codes.some(c=>c.name.startsWith('NFPA 13')));
});

test('capitalized completion values and applicability retain conservative evidence requirements',()=>{
  const finish={brief:'The saved evidence leaves individual NFPA adoption questions unresolved.',coverage:{jurisdiction:'SUPPORTED',contacts:'Unresolved',codes:'UNRESOLVED',process:'NOT_APPLICABLE'},standards:fireProfile(input).map(t=>({standard:t.standard,applicability:'Unresolved',finding:'Obtain the official adoption chain and edition from the responsible AHJ.'}))};
  const original=structuredClone(finish);
  assert.equal(completionError(finish,'codes',input),'');assert.match(completionBrief(finish),/NFPA 13 \| unresolved \|/);assert.deepEqual(finish,original);
  assert.ok(completionError({...finish,coverage:{...finish.coverage,codes:'SUPPORTED'}},'codes',input));
  assert.ok(completionError({...finish,coverage:{...finish.coverage,codes:'NOT_APPLICABLE'}},'codes',input));
  assert.ok(completionError({...finish,standards:finish.standards.map(c=>({...c,applicability:'Maybe'}))},'codes',input));
  assert.ok(completionError({...finish,coverage:{...finish.coverage,codes:'UnresolveD-ish'}},'codes',input));
  const valid=checked([row({status:'VERIFIED',adoptionType:'DIRECT',applicabilityStatus:'CONDITIONAL'})]).fireStandards[0];
  assert.equal(valid.status,'verified');assert.equal(valid.adoptionType,'direct');assert.equal(valid.applicabilityStatus,'conditional');
  assert.equal(checked([row({status:'VERIFIED',applicabilityStatus:'APPLICABLE',evidence:[]})]).fireStandards[0].status,'unverified');
  assert.equal(checked([row({applicabilityStatus:'NOT_APPLICABLE',evidence:[]})]).fireStandards[0].applicabilityStatus,'unresolved');
  assert.equal(checked([row({applicabilityStatus:'Maybe'})]).fireStandards[0].applicabilityStatus,'unresolved');
  const exclusion=checked([row({edition:'',status:'VERIFIED',applicabilityStatus:'NOT_APPLICABLE'})]).fireStandards[0];
  assert.equal(exclusion.applicabilityStatus,'not_applicable');assert.equal(exclusion.status,'verified');
  const wrongId=checked([row({status:'VERIFIED',adoptionSourceId:'s1'})]).fireStandards[0];assert.equal(wrongId.status,'unverified');
});
test('saved answers and closures suppress the same NFPA confirm question without matching a different designation',()=>{
  const confirm=id=>`Confirm ${id}: applicability and adopted edition.`;
  const answered=[{id:questionId('Which sprinkler standard applies?'),question:'Which sprinkler standard applies?',status:'answered',answer:'Use NFPA 13, 2019 edition.'}];
  const honored=validateReport(report(),[source],[],[],input,answered);
  assert.ok(!honored.gaps.some(g=>g.question===confirm('NFPA 13')));
  assert.ok(honored.gaps.some(g=>g.question===confirm('NFPA 72')));
  const residential=[{id:questionId('Which residential standard applies?'),question:'Which residential standard applies?',status:'answered',answer:'NFPA 13R applies to this building.'}];
  assert.ok(validateReport(report(),[source],[],[],input,residential).gaps.some(g=>g.question===confirm('NFPA 13')));
  const closed=[{id:questionId(confirm('NFPA 72')),question:confirm('NFPA 72'),status:'closed',answer:'',reason:CLOSURE_REASON}];
  const kept=validateReport(report(),[source],[],[],input,closed);
  assert.ok(!kept.gaps.some(g=>g.question===confirm('NFPA 72')));
  assert.ok(kept.gaps.some(g=>g.question===confirm('NFPA 13')));
  const reworded=[{id:questionId('What alarm standard should we list?'),question:'What alarm standard should we list?',status:'closed',answer:'',reason:CLOSURE_REASON}];
  assert.ok(validateReport(report(),[source],[],[],input,reworded).gaps.some(g=>g.question===confirm('NFPA 72')));
});
test('additional standards discovered by researchers cannot disappear from the final report',()=>{
  const out=validateReport(report(),[source],[{id:'codes',status:'complete',output:'NFPA 750 | conditional | Investigate water mist alternative and its adoption basis.'}],[],input);
  assert.ok(out.fireStandards.some(r=>r.name.startsWith('NFPA 750')&&r.status==='unverified'));assert.ok(out.gaps.some(g=>g.question.includes('NFPA 750')));
});
test('table cells, Canadian referenced-documents rows and French editions verify, and Canadian parent-code years do not',()=>{
  const lines=['NFPA | 13-2019 | Installation of Sprinkler Systems | 3.2.4.8.(4)','NFPA | 13R-2016 | Residential Sprinklers | 3.2.5.12.(2)','NFPA 13 | 2019 | Sprinkler systems','La norme NFPA 13, édition 2019, s’applique.','NFPA 13, National Building Code of Canada, 2020','NFPA 13 as referenced in the 2024 OBC'];
  const s={...source,text:source.text+' '+lines.join(' ')};
  const status=(edition,quote,pageOrSection='Division B, Table 1.3.1.2')=>{const r=report();r.fireStandards=[row({edition,evidence:[{sourceId:'S1',quote,pageOrSection}]})];return validateReport(r,[structuredClone(s)],[],[],input).fireStandards[0].status;};
  assert.equal(status('2019',lines[0]),'verified');
  assert.equal(status('2016',lines[1]),'unverified');
  assert.equal(status('2019',lines[2],'Adoption table'),'verified');
  assert.equal(status('2019',lines[3],'Code de construction'),'verified');
  assert.equal(status('2020',lines[4],'Sentence 3.2.5.13.(1)'),'unverified');
  assert.equal(status('2024',lines[5],'Ontario'),'unverified');
});
test('a Canadian fire protection project is pointed to the Canadian referenced-documents table',async t=>{
  const {store}=fixture(t),us=store.create(input),canada=store.create({...input,address:'1 King St W, Toronto, ON M5H 1A1',country:'Canada'});
  const codes=p=>researchPayload(store,p,store.stage(p.id,'codes')).messages[0].content;
  assert.match(codes(canada),/referenced-standards chapter \(for example Division B, Table 1\.3\.1\.2 of the national or provincial building or fire code\)/);
  assert.match(codes(us),/referenced-standards chapter \(for example IBC Chapter 35 or IFC Chapter 80\)/);
  assert.match(reviewPayload(store,canada).system,/Division B, Table 1\.3\.1\.2 of the national or provincial building or fire code/);
});
test('compact reference-table notation works without confusing NFPA 13 and 13R',()=>{
  const r=report(),s={...source,text:source.text+' 13—19 Standard for the Installation of Sprinkler Systems. 13R—16 Residential Sprinklers.'};r.fireStandards=[row({evidence:[...row().evidence,{sourceId:'S1',quote:'13—19 Standard for the Installation of Sprinkler Systems.',pageOrSection:'NFPA referenced standards table'}]})];
  assert.equal(validateReport(r,[s],[],[],input).fireStandards[0].status,'verified');
  r.fireStandards=[row({edition:'2016',evidence:[{sourceId:'S1',quote:'13R—16 Residential Sprinklers.',pageOrSection:'NFPA referenced standards table'}]})];assert.equal(validateReport(r,[s],[],[],input).fireStandards[0].status,'unverified');
});
test('focused refresh resets only code, verification and review while retaining evidence, costs and cumulative limits',async t=>{
  const {store:s,engine:e}=fixture(t),p=s.create(input);e.tick=async()=>{};
  for(const st of s.stages(p.id))s.updateStage(p.id,st.id,{status:'complete',output:'Saved '+st.id,messages:[{role:'user',content:'Saved signed history'}],rounds:7});
  s.source(p.id,{url:source.url,text:source.text,readFull:true});s.updateProject(p.id,{report:report(),status:'partial',searches:8,reads:41});const a=s.reserve(p.id,'codes',{mode:'realtime',modelKey:'research',payload:{},reserve:500});s.updateAttempt(a.id,{state:'settled',actual:500,applied:1,usage:{server_tool_use:{web_search_requests:8}}});for(let n=0;n<41;n++)s.beginTool(a.id,'saved_read_'+n,'read_source');const before=s.project(p.id);
  await e.resume(p.id,{focus:'fire_protection',mode:'batch'});
  for(const id of ['jurisdiction','contacts']){assert.equal(s.stage(p.id,id).status,'complete');assert.equal(s.stage(p.id,id).rounds,7);}
  for(const id of ['codes','verification','review']){assert.equal(s.stage(p.id,id).status,'queued');assert.deepEqual(s.stage(p.id,id).messages,[]);assert.equal(s.stage(p.id,id).rounds,0);assert.equal(s.stage(p.id,id).output,'Saved '+id);}
  const after=s.project(p.id);assert.equal(after.cost,before.cost);assert.equal(after.searches,8);assert.equal(after.reads,41);assert.equal(after.mode,'batch');assert.deepEqual(after.report,before.report);assert.equal(s.sources(p.id).length,1);
  await assert.rejects(e.resume(p.id,{focus:'fire_protection',clarification:'A new occupancy'}),/scope change/);
  const b=s.reserve(p.id,'codes',{mode:'batch',modelKey:'research',payload:{},reserve:500});s.updateAttempt(b.id,{state:'unknown'});await assert.rejects(e.resume(p.id,{focus:'fire_protection'}),/outstanding/);
});
test('NFPA fields survive compact transport and appear in Excel and PDF exports',async()=>{
  const r=report();r.fireStandards=[row()];assert.deepEqual(decodeReport(encodeReport(r)),r);
  const data={project:{...input,status:'partial',processingMode:'realtime',estimatedApiCost:0,estimatedPendingCost:0,context:input},report:checked([row()]),sources:[{...source,title:'Synthetic adoption',retrieved:new Date().toISOString(),excerpt:source.text,kind:'web'}],stageBriefs:[],exportedAt:new Date().toISOString(),limitations:'Synthetic data; not regulatory guidance.'};
  const book=new ExcelJS.Workbook();await book.xlsx.load(await excelReport(data));const ws=book.getWorksheet('NFPA standards');assert.equal(ws.getCell('B2').value,'2019');assert.equal(ws.getCell('C2').value,'applicable');assert.equal(ws.getCell('L2').value,'S1');assert.equal(ws.rowCount,fireProfile(input).length+1);
  const pdf=await pdfReport(data),{getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs'),doc=await getDocument({data:new Uint8Array(pdf),isEvalSupported:false,useSystemFonts:true}).promise;let text='';for(let i=1;i<=doc.numPages;i++)text+=(await(await doc.getPage(i)).getTextContent()).items.map(x=>x.str).join(' ');assert.match(text,/Fire protection - NFPA standards/);assert.match(text,/NFPA 72/);assert.match(text,/2019/);await doc.loadingTask.destroy();
});
