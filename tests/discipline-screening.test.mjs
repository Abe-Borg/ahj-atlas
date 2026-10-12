import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import ExcelJS from 'exceljs';
import { screeningProfile,screeningView,standardIds,DISCIPLINE_PROFILES } from '../lib/screening.mjs';
import { researchPayload,reviewPayload,validateReport,completionError } from '../lib/prompts.mjs';
import { encodeReport,decodeReport,reportWireSchema,REPORT_WIRE_SCHEMA,REPORT_FORMAT_INSTRUCTIONS } from '../lib/report-format.mjs';
import { questionId } from '../lib/questions.mjs';
import { Store } from '../lib/store.mjs';
import { Engine } from '../lib/engine.mjs';
import { excelReport,pdfReport } from '../lib/exports.mjs';
import { input,report,evidenceText,FakeProvider,fakeTools } from './fixtures.mjs';

const mechanical={...input,discipline:'Mechanical'},canada={address:'1 King St W, Toronto, ON M5H 1A1',country:'Canada'};
const source={id:'S1',url:'https://example.com/adoption',text:evidenceText+' The district adopts ANSI/ASHRAE/IES Standard 90.1-2019 for commercial buildings. Refrigeration systems comply with ASHRAE 15 as referenced by the 2021 International Mechanical Code.',read_full:true};
const row=(changes={})=>({name:'ASHRAE 90.1 — Energy standard',edition:'2019',authority:'Example District',adoptionType:'direct',adoptionInstrument:'District synthetic adoption instrument',effectiveDate:'',amendments:'Not established',applicability:'HVAC efficiency in the synthetic project.',notes:'Synthetic test only.',status:'verified',applicabilityStatus:'applicable',adoptionSourceId:'S1',editionSourceId:'S1',evidence:[{sourceId:'S1',quote:'The district adopts ANSI/ASHRAE/IES Standard 90.1-2019 for commercial buildings.',pageOrSection:'Synthetic adoption provision'}],...changes});
const checked=(rows=[],i=mechanical,s=source)=>{const r=report();r.standards=rows;return validateReport(r,[structuredClone(s)],[],[],i);};
const finding='No adoption evidence in the synthetic source. Ask for the official reference table.';
const checklist=(i=mechanical)=>screeningProfile(i).targets.map(t=>({standard:t.standard,applicability:'unresolved',finding}));
function fixture(t){const dir=mkdtempSync(path.join(os.tmpdir(),'ahj-atlas-test-screening-')),store=new Store(dir),provider=new FakeProvider(),engine=new Engine(store,provider,()=>true,{autoStart:false,tools:fakeTools(store)});t.after(async()=>{await engine.close();store.close();assert.ok(path.resolve(dir).startsWith(path.join(os.tmpdir(),'ahj-atlas-test-screening-')));rmSync(dir,{recursive:true,force:true});});return {store,provider,engine};}

test('every listed discipline has a US and Canadian checklist without editions; context adds candidates',()=>{
  for(const discipline of ['Architecture','Structural','Mechanical','Electrical','Plumbing','Civil'])for(const place of [{},canada]){
    const profile=screeningProfile({...input,discipline,...place});
    assert.ok(profile&&!profile.fire&&profile.rowsKey==='standards'&&profile.targets.length>=3,discipline);
    // Each target is one designation that the parser and the report validator read back unchanged.
    for(const t of profile.targets){assert.ok(!('edition' in t));assert.deepEqual(standardIds(t.standard),[t.standard],t.standard);assert.deepEqual(profile.ids(t.standard+' — '+t.topic),[t.standard],t.standard);assert.ok(profile.single(t.standard+' — '+t.topic),t.standard);}
  }
  assert.deepEqual(DISCIPLINE_PROFILES,['architecture','structural','mechanical','electrical','plumbing','civil']);
  const ids=i=>screeningProfile(i).targets.map(t=>t.standard);
  assert.ok(ids(mechanical).includes('ASHRAE 62.1'));assert.ok(!ids(mechanical).includes('ASHRAE 90.4'));
  assert.ok(ids({...mechanical,occupancy:'Hyperscale data center'}).includes('ASHRAE 90.4'));
  assert.ok(ids({...mechanical,...canada}).includes('CSA B52'));assert.ok(!ids({...mechanical,...canada}).includes('NFPA 90A'));
  assert.ok(ids({...input,discipline:'Structural',...canada}).includes('CSA A23.3'));assert.ok(!ids({...input,discipline:'Structural',...canada}).includes('ACI 318'));
  assert.ok(ids({...input,discipline:'Structural'}).includes('ASCE 41'),'the fixture scope is a renovation');assert.ok(!ids({...input,discipline:'Structural',scope:'New construction'}).includes('ASCE 41'));
  assert.ok(ids({...input,discipline:'Electrical',notes:'Lithium-ion UPS batteries.'}).includes('NFPA 855'));
  assert.ok(ids({...mechanical,notes:'Coordinate with ASHRAE 241.'}).includes('ASHRAE 241'));
  const answered={...input,discipline:'Plumbing',questionResponses:[{status:'answered',answer:'There is a propane tank.'}]};assert.ok(ids(answered).includes('NFPA 58'));assert.ok(!ids({...answered,questionResponses:[{status:'dismissed',answer:'There is a propane tank.'}]}).includes('NFPA 58'));
  const mep=screeningProfile({...input,discipline:'MEP'});assert.equal(mep.label,'Mechanical, electrical and plumbing');for(const id of ['ASHRAE 62.1','NFPA 70','ASSE 1013'])assert.ok(mep.targets.some(t=>t.standard===id));
  assert.equal(screeningProfile({...input,discipline:'Acoustics'}),null);assert.equal(screeningView({...input,discipline:'Acoustics'}),null);
  assert.ok(screeningProfile({...input,discipline:'Fire alarm'}).fire);assert.equal(screeningProfile(input).rowsKey,'fireStandards');
});
test('designations: co-publishers, edition suffixes, aliases and names resolve to one standard; lists do not',()=>{
  assert.deepEqual(standardIds('ANSI/ASHRAE/IES Standard 90.1-2019; ASCE/SEI 7-22; ACI 318-19; CAN/CSA-B64.10; NSF/ANSI 61; ANSI A117.1-2017; UL 60335-2-40; ASME CSD-1'),['ASHRAE 90.1','ASCE 7','ACI 318','CSA B64.10','NSF 61','ICC A117.1','UL 60335-2-40','ASME CSD-1']);
  assert.deepEqual(standardIds('the 2023 National Electrical Code (NFPA 70) and the NESC'),['NFPA 70','IEEE C2']);
  const p=screeningProfile(mechanical);
  for(const value of ['ASHRAE 62.1 and 90.1','ASHRAE 15 / NFPA 90A','NFPA 70, 72 and 110'])assert.equal(p.row(value).error,'one designation per row',value);
  assert.equal(p.row('Ontario Building Code').error,'a designation such as ASHRAE 62.1 or NFPA 90A');
  assert.deepEqual(p.row('ANSI/ASHRAE Standard 62.1-2019'),{standard:'ASHRAE 62.1',label:'ANSI/ASHRAE Standard 62.1-2019'});
  assert.deepEqual(p.row('AWS D1.1/D1.1M'),{standard:'AWS D1.1',label:'AWS D1.1/D1.1M'});
  assert.deepEqual(p.row('FM Global Data Sheet 5-32'),{standard:'FM Global Data Sheet 5-32',label:''});
});
test('edition evidence must tie the year to this designation, not a parent code or neighbor',()=>{
  const p=screeningProfile({...input,discipline:'MEP'});
  const cases=[
    ['ASHRAE 90.1','2019','The county adopts ANSI/ASHRAE/IES Standard 90.1-2019 as an alternative compliance path.',true],
    ['ASHRAE 90.1','2022','The county adopts ANSI/ASHRAE/IES Standard 90.1-2019 as an alternative compliance path.',false],
    ['ASHRAE 90.1','2021','The 2021 IECC Section C401.2 permits ASHRAE 90.1 compliance.',false],
    ['ASHRAE 90.1','2021','IECC 2021 ASHRAE 90.1 compliance path',false],
    ['ASHRAE 62.1','2019','ASHRAE 62.1 and ASHRAE 90.1-2019 apply.',false],
    ['NFPA 70','2023','The city adopts the 2023 edition of the National Electrical Code with amendments.',true],
    ['NFPA 70','2023','Electrical permits follow the 2023 NEC.',true],
    ['NFPA 70','2020','NFPA 70, National Electrical Code, 2020 edition, is adopted.',true],
    ['NFPA 70','2021','NFPA 70 as referenced by the 2021 International Building Code.',false],
    ['NFPA 70E','2023','NFPA 70E as referenced in the 2023 NEC.',false],
    ['ASCE 7','2022','Structural design loads per ASCE/SEI 7-22.',true],
    ['ASCE 7','2016','Structural design loads per ASCE/SEI 7-22.',false],
    ['ACI 318','2019','ACI 318-19 Building Code Requirements for Structural Concrete',true],
    ['AWS D1.1','2020','AWS D1.1/D1.1M:2020 Structural Welding Code',true],
    ['CSA C22.1','2021','the Canadian Electrical Code, Part I, 2021 edition',true],
    ['CSA B149.1','2020','CSA B149.1-20, Natural gas and propane installation code',true],
    ['ICC A117.1','2017','accessible elements comply with ANSI A117.1-2017',true],
    ['NFPA 54','2021','the 2021 National Fuel Gas Code',true],
  ];
  for(const [id,edition,quote,expected] of cases)assert.equal(p.edition(quote,id,edition,''),expected,`${id} ${edition}: ${quote}`);
  assert.equal(p.edition('318—19 Building Code Requirements for Structural Concrete','ACI 318','2019','ACI referenced standards table'),true);
  assert.equal(p.edition('318—19 Building Code Requirements for Structural Concrete','ACI 318','2019','Chapter 19'),false);
});
test('codes and verification carry the discipline checklist; contacts name the discipline offices',t=>{
  const {store:s}=fixture(t),m=s.create({...mechanical,occupancy:'Hyperscale data center'}),st=s.create({...input,discipline:'Structural'}),fire=s.create(input);
  for(const id of ['codes','verification']){const payload=researchPayload(s,m,s.stage(m.id,id));assert.ok(payload.tools.find(t=>t.name==='finish_research').input_schema.properties.standards);assert.match(payload.messages[0].content,/MECHANICAL STANDARDS COVERAGE \(version 1\):\nASHRAE 15 \| Refrigeration system safety/);assert.match(payload.messages[0].content,/ASHRAE 90\.4 \| Energy standard for data centers \| Screen because/);}
  for(const id of ['jurisdiction','contacts'])assert.ok(!researchPayload(s,m,s.stage(m.id,id)).tools.at(-1).input_schema.properties.standards);
  const contacts=p=>researchPayload(s,p,s.stage(p.id,'contacts')).messages[0].content;
  assert.match(contacts(m),/discipline plan reviewers, the Fire Marshal\/fire prevention office \(smoke control, fire dampers and fuel storage\) and any air quality agency/);
  assert.match(contacts(st),/Include the building department, discipline plan reviewers, structural plan review and the special inspection program, and relevant utilities/);assert.doesNotMatch(contacts(st),/Fire Marshal/);
  assert.match(contacts(fire),/Include the building department, Fire Marshal\/fire prevention office, discipline plan reviewers, and relevant utilities or public works\./);
  const review=reviewPayload(s,m);assert.match(review.system,/standards \(13 fields\)/);assert.doesNotMatch(review.system,/fireStandards/);assert.match(review.system,/Put individual screened standard rows in standards, not codes/);
  assert.ok(review.output_config.format.schema.properties.items.items.properties.section.enum.includes('standards'));assert.ok(!review.output_config.format.schema.properties.items.items.properties.section.enum.includes('fireStandards'));
  // Fire protection and disciplines without a checklist keep the original grammar and instructions.
  assert.deepEqual(reviewPayload(s,fire).output_config.format.schema,REPORT_WIRE_SCHEMA);assert.ok(reviewPayload(s,fire).system.includes(REPORT_FORMAT_INSTRUCTIONS));
  const canadian=s.create({...mechanical,...canada});assert.match(researchPayload(s,canadian,s.stage(canadian.id,'codes')).messages[0].content,/CSA B52 \| Mechanical refrigeration code[\s\S]*Division B, Table 1\.3\.1\.2 of the national or provincial building and energy codes/);
});
test('completion needs one row per discipline target; co-published and labelled rows count',()=>{
  const done={brief:'The synthetic agency adopts a mechanical code, but standards are not established.',coverage:{jurisdiction:'not_applicable',contacts:'not_applicable',codes:'supported',process:'not_applicable'}};
  assert.match(completionError(done,'codes',mechanical),/Every required screening target needs a separate finding/);
  done.standards=checklist();assert.match(completionError(done,'codes',mechanical),/Standards checks remain unresolved/);done.coverage.codes='unresolved';assert.equal(completionError(done,'codes',mechanical),'');
  done.standards=done.standards.map(c=>c.standard==='ASHRAE 62.1'?{...c,standard:'ANSI/ASHRAE Standard 62.1-2019'}:c);assert.equal(completionError(done,'codes',mechanical),'');
  assert.match(completionError({...done,standards:done.standards.filter(c=>c.standard!=='NFPA 90A')},'codes',mechanical),/The standards checklist is missing NFPA 90A\./);
  assert.match(completionError({...done,standards:[...done.standards,{standard:'ASHRAE 15 and 34',applicability:'unresolved',finding}]},'codes',mechanical),/"ASHRAE 15 and 34" needs one designation per row.*for example ASHRAE 62\.1 or NFPA 90A/);
  assert.equal(completionError({...done,standards:undefined},'codes',{...input,discipline:'Acoustics'}),'');
});
test('report validation: matching editions verify, omitted targets become questions, code rows with designations move',()=>{
  const out=checked([row()]);const asr=out.standards.find(r=>r.name.startsWith('ASHRAE 90.1'));assert.equal(asr.status,'verified');assert.ok(!out.fireStandards);
  assert.equal(out.standards.length,screeningProfile(mechanical).targets.length);assert.ok(out.standards.filter(r=>r!==asr).every(r=>r.status==='unverified'&&r.edition===''));
  assert.ok(out.gaps.some(g=>g.question==='Confirm ASHRAE 62.1: applicability and adopted edition.'));assert.ok(!out.gaps.some(g=>g.question.startsWith('Confirm ASHRAE 90.1')));
  assert.deepEqual({...out.screening,targets:out.screening.targets.length},{profile:'mechanical',label:'Mechanical',profileVersion:1,targets:screeningProfile(mechanical).targets.length,unresolved:out.standards.length-1,scopeConditional:0,applicabilityUnresolved:out.standards.length-1,evidenceUnresolved:out.standards.length-1});
  assert.match(out.coverage.codes,/^Mechanical: \d+ individual standard findings; \d+ need confirmation\./);
  for(const changes of [{edition:'2022'},{adoptionSourceId:'Missing'},{adoptionInstrument:''},{adoptionType:'guidance'},{name:'ASHRAE 15',edition:'2021',evidence:[{sourceId:'S1',quote:'Refrigeration systems comply with ASHRAE 15 as referenced by the 2021 International Mechanical Code.',pageOrSection:'test'}]}])assert.equal(checked([row(changes)]).standards.find(r=>r.name.startsWith(changes.name||'ASHRAE 90.1')).status,'unverified',JSON.stringify(changes));
  // A code row naming one designation joins the section; a grouped one becomes a question.
  const moved=report();moved.codes.push(row({name:'ANSI/ASHRAE/IES Standard 90.1-2019',applicabilityStatus:undefined,adoptionSourceId:undefined,editionSourceId:undefined}),row({name:'ASHRAE 62.1 and 90.1'}));
  const v=validateReport(moved,[source],[],[],mechanical);assert.ok(v.standards.some(r=>r.name==='ANSI/ASHRAE/IES Standard 90.1-2019'));assert.ok(!v.codes.some(c=>/ASHRAE/.test(c.name)));assert.ok(v.gaps.some(g=>g.question==='Separate the grouped standards finding: ASHRAE 62.1 and 90.1'));
  // Rows the model put in the NFPA section of a mechanical report are not lost.
  const misplaced=report();misplaced.fireStandards=[row()];assert.ok(validateReport(misplaced,[source],[],[],mechanical).standards.some(r=>r.name.startsWith('ASHRAE 90.1')));
  // A row naming a publisher the parser does not know is kept as a code row, not reported as grouped.
  for(const [i,key,name] of [[mechanical,'standards','SMACNA HVAC Duct Construction Standards'],[input,'fireStandards','CAN/ULC-S524 Installation of Fire Alarm Systems']]){
    const unknown=report();unknown[key]=[row({name})];const out=validateReport(unknown,[source],[],[],i);
    assert.ok(out.codes.some(c=>c.name===name),name);assert.ok(!out[key].some(r=>r.name===name),name);assert.ok(!out.gaps.some(g=>g.question.startsWith('Separate the grouped')),name);
  }
  // A discipline without a checklist keeps a standards row in its code table.
  const plain=checked([row()],{...input,discipline:'Acoustics'});assert.ok(!plain.standards);assert.ok(!plain.screening);assert.ok(plain.codes.some(c=>c.name.startsWith('ASHRAE 90.1')));
  // A saved answer naming the standard suppresses its confirmation question.
  const answered=[{id:questionId('Which ventilation standard applies?'),question:'Which ventilation standard applies?',status:'answered',answer:'The county uses ASHRAE 62.1-2019.'}];
  assert.ok(!validateReport(report(),[source],[],[],mechanical,answered).gaps.some(g=>g.question.startsWith('Confirm ASHRAE 62.1')));
  // Standards that research checked stay in the report: designated rows become targets, others questions.
  const stages=[{id:'codes',status:'complete',output:'Brief.\n\nSTANDARDS CHECKLIST\nASHRAE 241 | conditional | Owner criteria may require it; confirm.\nSMACNA HVAC Duct Construction Standards 2005 | unresolved | Edition not found.'}];
  const kept=validateReport(report(),[source],stages,[],mechanical);assert.ok(kept.standards.some(r=>r.name.startsWith('ASHRAE 241')));assert.ok(kept.gaps.some(g=>g.question==='Confirm SMACNA HVAC Duct Construction Standards 2005: applicability and adopted edition.'));
});
test('the standards section survives transport and exports',async()=>{
  const r=report();r.standards=[row()];assert.deepEqual(decodeReport(encodeReport(r)),r);
  assert.deepEqual(reportWireSchema().properties.items.items.properties.section.enum,REPORT_WIRE_SCHEMA.properties.items.items.properties.section.enum);assert.ok(JSON.stringify(reportWireSchema('standards')).length<900);
  const data={project:{...mechanical,status:'partial',processingMode:'realtime',estimatedApiCost:0,estimatedPendingCost:0,context:mechanical},report:checked([row()]),sources:[{...source,title:'Synthetic adoption',retrieved:new Date().toISOString(),excerpt:source.text,kind:'web'}],stageBriefs:[],exportedAt:new Date().toISOString(),limitations:'Synthetic data; not regulatory guidance.'};
  const book=new ExcelJS.Workbook();await book.xlsx.load(await excelReport(data));const ws=book.getWorksheet('Referenced standards');assert.equal(ws.getCell('A1').value,'Standard');assert.equal(ws.rowCount,screeningProfile(mechanical).targets.length+1);assert.ok(!book.getWorksheet('NFPA standards'));
  const pdf=await pdfReport(data),{getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs'),doc=await getDocument({data:new Uint8Array(pdf),isEvalSupported:false,useSystemFonts:true}).promise;let text='';for(let i=1;i<=doc.numPages;i++)text+=(await(await doc.getPage(i)).getTextContent()).items.map(x=>x.str).join(' ');assert.match(text,/Mechanical - referenced standards/);assert.match(text,/ASHRAE 62\.1/);await doc.loadingTask.destroy();
});
test('a mechanical project runs to a report with its standards section, and the focused update reopens only codes onward',async t=>{
  const {store:s,engine:e}=fixture(t),p=s.create({...mechanical,occupancy:'Hyperscale data center'});
  for(let i=0;i<40&&!s.project(p.id).report;i++){await e.tick();for(let n=0;n<150&&(e.running.size||e.polling.size||e.applying.size);n++)await new Promise(r=>setTimeout(r,5));}
  const done=s.project(p.id);assert.ok(done.report,done.note);assert.ok(['codes','verification'].every(id=>s.stage(p.id,id).status==='complete'));
  assert.equal(done.report.standards.length,screeningProfile(done.input).targets.length);assert.equal(done.report.screening.profile,'mechanical');assert.ok(s.stage(p.id,'codes').output.includes('\nSTANDARDS CHECKLIST\nASHRAE 15 | unresolved |'));
  assert.ok(s.events(p.id).some(x=>/\d+ code\/standard entries/.test(x.message)));
  e.tick=async()=>{};await e.resume(p.id,{focus:'standards'});
  assert.deepEqual(s.stages(p.id).map(x=>[x.id,x.status]),[['jurisdiction','complete'],['contacts','complete'],['codes','queued'],['verification','queued'],['review','queued']]);
  assert.ok(s.events(p.id).some(x=>x.message.startsWith('Focused standards research started.')));
  const plain=s.create({...input,discipline:'Acoustics'});await assert.rejects(e.resume(plain.id,{focus:'standards'}),/requires a discipline with a standards checklist/);
});
