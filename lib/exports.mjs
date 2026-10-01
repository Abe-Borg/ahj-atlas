import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';
import { existsSync } from 'node:fs';

export function exportData(store,id){
  const p=store.project(id);if(!p)throw new Error('Project not found.');
  const {input,report}=p;
  return {application:'AHJ Atlas',exportedAt:new Date().toISOString(),project:{name:p.name,address:p.address,discipline:p.discipline,context:input,processingMode:p.mode,status:p.status,estimatedApiCost:p.cost,estimatedPendingCost:p.reserved},report:report||null,notes:store.notes(id).map(({title,text,created})=>({title,note:text,saved:created,origin:'Saved from project chat by the user; not re-verified by research'})),questions:p.questions,questionUpdatesPending:p.questionUpdatesPending,stageBriefs:store.stages(id).map(s=>({stage:s.id,status:s.status,findings:s.output,note:s.note})),sources:store.sources(id).map(({project_id,text,...s})=>({...s,excerpt:text.slice(0,16000)})),limitations:report?.disclaimer||'Research is incomplete. These are saved findings and sources, not a confirmed code or jurisdiction determination.'};
}
const text=v=>String(v??'');
const evidence=(row,sources)=>(row.evidence||[]).map(e=>`${e.sourceId}${e.pageOrSection?' · '+e.pageOrSection:''}: ${sources.find(s=>s.id===e.sourceId)?.url||''}${e.quote?' — “'+e.quote+'”':''}`).join('\n');
export async function excelReport(data){
  const book=new ExcelJS.Workbook();book.creator='AHJ Atlas';book.created=new Date();
  function sheet(name,headers,rows,widths=[]){
    const ws=book.addWorksheet(name,{views:[{state:'frozen',ySplit:1}]});
    ws.columns=headers.map((header,i)=>({header,key:String(i),width:widths[i]||30}));
    for(const row of rows)ws.addRow(row.map(v=>text(v).slice(0,32000)));
    ws.getRow(1).height=27;ws.getRow(1).font={bold:true,color:{argb:'FFFFFFFF'},size:11};ws.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF123345'}};
    ws.eachRow((r,n)=>{r.alignment={vertical:'top',wrapText:true};if(n>1){r.font={name:'Calibri',size:11,color:{argb:'FF183646'}};if(n%2===0)r.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFF0F5F7'}};}});
    ws.autoFilter={from:{row:1,column:1},to:{row:Math.max(1,rows.length+1),column:headers.length}};return ws;
  }
  const p=data.project,r=data.report||{},sources=data.sources;
  sheet('Project',['Field','Value'],[['Project',p.name],['Address',p.address],...(p.context?.siteDescription?[['Parcel / site description',p.context.siteDescription]]:[]),...(p.context?.previousAddresses?.length?[['Previous addresses',p.context.previousAddresses.join('\n')]]:[]),['Discipline',p.discipline],['Status',p.status],['Mode',p.processingMode],['Research date',data.exportedAt],['Estimated API cost',`$${p.estimatedApiCost.toFixed(4)}`],['Estimated pending cost',`$${p.estimatedPendingCost.toFixed(4)}`],['Summary',r.summary||'Research is incomplete.'],['Jurisdiction',r.jurisdiction?.description||'Not yet determined'],['Jurisdiction status',r.jurisdiction?.status||'Unverified'],['Jurisdiction evidence',evidence(r.jurisdiction||{},sources)],['Limitations',data.limitations]],[25,110]);
  sheet('Codes',['Code / standard','Edition','Authority','Adoption type','Adoption instrument','Effective date','Local amendments','Applicability','Status','Notes','Evidence'],(r.codes||[]).map(c=>[c.name,c.edition,c.authority,c.adoptionType,c.adoptionInstrument,c.effectiveDate,c.amendments,c.applicability,c.status,c.notes,evidence(c,sources)]));
  if(r.fireStandards?.length)sheet('NFPA standards',['NFPA standard','Edition','Applicability finding','Scope / basis','Authority','Adoption type','Adoption instrument','Effective date','Local amendments','Evidence status','Notes','Adoption source ID','Edition source ID','Evidence'],r.fireStandards.map(c=>[c.name,c.edition,c.applicabilityStatus,c.applicability,c.authority,c.adoptionType,c.adoptionInstrument,c.effectiveDate,c.amendments,c.status,c.notes,c.adoptionSourceId,c.editionSourceId,evidence(c,sources)]));
  sheet('Contacts',['Name','Title','Organization','Responsibility','Email','Phone','Address','Website','Status','Notes','Evidence'],(r.contacts||[]).map(c=>[c.name,c.title,c.organization,c.responsibility,c.email,c.phone,c.address,c.website,c.status,c.notes,evidence(c,sources)]));
  sheet('Authorities',['Organization','Responsibility','Website','Phone','Email','Address','Status','Evidence'],(r.authorities||[]).map(c=>[c.name,c.responsibility,c.website,c.phone,c.email,c.address,c.status,evidence(c,sources)]));
  sheet('Submission requirements',['Requirement','Authority','Details','Website','Status','Evidence'],(r.requirements||[]).map(c=>[c.title,c.authority,c.details,c.website,c.status,evidence(c,sources)]));
  sheet('Questions to resolve',['Question','Why it matters','Contact','Next step','Status','User-provided answer','Reason','Updated'],(data.questions||r.gaps||[]).map(g=>[g.question,g.why,g.contact,g.nextStep,g.status||'open',g.answer,g.reason,g.updated]),[45,50,30,60,18,60,60,25]);
  if(data.notes?.length)sheet('Notes',['Title','Note','Origin','Saved'],data.notes.map(n=>[n.title,n.note,n.origin,n.saved]),[40,110,45,25]);
  sheet('Sources',['Source ID','Title','URL','Retrieved','Reading method','Read as evidence','Document date','Excerpt'],sources.map(s=>[s.id,s.title,s.url,s.retrieved,s.kind,s.read_full?'Yes':'Discovery / visual only',s.document_date,s.excerpt]),[15,40,65,25,20,25,25,100]);
  sheet('Research briefs',['Stage','Status','Findings','Limitations'],data.stageBriefs.map(s=>[s.stage,s.status,s.findings,s.note]),[22,20,110,50]);
  return Buffer.from(await book.xlsx.writeBuffer());
}
export async function pdfReport(data){
  const doc=new PDFDocument({size:'A4',margin:48,bufferPages:true,info:{Title:`${data.project.name} — AHJ research`,Author:'AHJ Atlas',Subject:'Source-linked jurisdiction, contact and code research'}}),chunks=[];
  const finished=new Promise((resolve,reject)=>{doc.on('data',c=>chunks.push(c));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);});
  const fontPairs=[['C:/Windows/Fonts/arial.ttf','C:/Windows/Fonts/arialbd.ttf'],['/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf','/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf'],['/Library/Fonts/Arial.ttf','/Library/Fonts/Arial Bold.ttf']];
  const fonts=fontPairs.find(pair=>pair.every(existsSync));
  if(fonts){doc.registerFont('Atlas',fonts[0]);doc.registerFont('Atlas-Bold',fonts[1]);}
  const regular=fonts?'Atlas':'Helvetica',boldFont=fonts?'Atlas-Bold':'Helvetica-Bold';
  const width=499,ink='#183646',muted='#667B88',teal='#176653';
  function ensure(space=80){if(doc.y>doc.page.height-60-space)doc.addPage();}
  function para(value,{size=10,color=ink,gap=7,bold=false}={}){if(!value)return;ensure(30);doc.font(bold?boldFont:regular).fontSize(size).fillColor(color).text(text(value),{width,lineGap:3});doc.moveDown(gap/size);}
  function heading(value){ensure(100);doc.moveDown(.6);para(value,{size:15,bold:true,color:teal,gap:12});}
  function citations(item){for(const e of item.evidence||[]){para(`${e.sourceId}${e.pageOrSection?' · '+e.pageOrSection:''}${e.quote?' — '+e.quote:''}`,{size:8,color:muted,gap:4});}}
  para('AHJ ATLAS / PROJECT INTELLIGENCE',{size:10,bold:true,color:teal,gap:24});para(data.project.name,{size:25,bold:true,gap:9});para(data.project.address,{size:12,color:muted});if(data.project.context?.siteDescription)para(`Parcel / site: ${data.project.context.siteDescription}`,{size:10,color:muted});if(data.project.context?.previousAddresses?.length)para(`Address corrected. Previously: ${data.project.context.previousAddresses.join('; ')}`,{size:9,color:muted});para(`${data.project.discipline}  |  ${data.project.processingMode==='batch'?'Batch':'Real-time'}  |  ${data.project.status}`,{size:10,color:muted});para(`Exported ${new Date(data.exportedAt).toLocaleString()} · Estimated API cost $${data.project.estimatedApiCost.toFixed(3)}`,{size:9,color:muted,gap:18});
  const r=data.report;
  if(!r){heading('Research is incomplete');para(data.limitations);for(const stage of data.stageBriefs){heading(stage.stage+' — '+stage.status);para(stage.findings||'No findings collected.');para(stage.note,{color:muted});}}
  else{
    heading('Project briefing');para(r.summary);heading('Jurisdiction');para(r.jurisdiction.description);para(`Authority: ${r.jurisdiction.authority} · Evidence status: ${r.jurisdiction.status}`,{bold:true});para(r.jurisdiction.notes);citations(r.jurisdiction);
    heading('Authorities');for(const a of r.authorities){ensure(80);para(a.name,{size:12,bold:true});para(a.responsibility);para([a.phone,a.email,a.website].filter(Boolean).join(' | '),{size:9,color:muted});citations(a);}
    heading('Contacts');for(const c of r.contacts){ensure(90);para(c.name||c.organization,{size:12,bold:true});para([c.title,c.organization].filter(Boolean).join(' · '));para(c.responsibility);para([c.phone,c.email,c.address,c.website].filter(Boolean).join('\n'),{size:9,color:muted});para(c.notes,{size:9});citations(c);}
    for(const [title,rows] of [['Codes and standards',r.codes],['Fire protection - NFPA standards',r.fireStandards||[]]]){if(!rows.length)continue;heading(title);if(title.startsWith('Fire protection'))para('Screening findings: inclusion does not itself establish adoption or applicability. Conditional and unresolved entries need confirmation.',{size:9,color:muted});for(const c of rows){ensure(150);para(`${c.name} — ${c.edition||'Edition unconfirmed'}`,{size:12,bold:true});para(`${c.status.toUpperCase()} · ${c.adoptionType} · ${c.authority}`,{size:9,color:teal});for(const [label,key] of [['Applicability finding','applicabilityStatus'],['Adoption basis','adoptionInstrument'],['Effective date','effectiveDate'],['Local amendments','amendments'],['Applicability','applicability'],['Notes','notes']])if(c[key])para(`${label}: ${c[key]}`,{size:10});citations(c);}
    }
    heading('Submission requirements');for(const q of r.requirements){ensure(80);para(q.title,{size:12,bold:true});para(q.details);para(q.website,{size:9,color:muted});citations(q);}
    const questions=data.questions||r.gaps;
    heading('Questions to resolve');if(!questions.length)para('No additional questions were identified in this research. This does not certify completeness or compliance.');
    if(questions.some(g=>g.status&&g.status!=='open'))para('Answers are user-provided context, not independently verified evidence. Dismissed questions were set aside by the user. Closed questions were open on an earlier report and are not in the report that replaced it.',{size:9,color:muted});
    for(const g of questions){ensure(90);para(g.question,{bold:true});para(`Status: ${g.status||'open'}`,{size:9,color:teal});para(g.why);if(g.answer)para(`User-provided answer${g.status==='answered'?'':' (previous)'}: ${g.answer}`);if(g.reason)para(`Reason: ${g.reason}`);if(!g.status||g.status==='open')para(`Next step: ${g.nextStep}${g.contact?' · Contact: '+g.contact:''}`,{size:9,color:muted});}
  }
  if(data.notes?.length){heading('Notes');para('Saved from project chat by the user. They record what that conversation concluded, with its citations, and were not re-verified by research.',{size:9,color:muted});for(const n of data.notes){ensure(70);para(n.title,{bold:true});para(n.note);para(`Saved ${new Date(n.saved).toLocaleString()}`,{size:8,color:muted});}}
  heading('Source register');for(const s of data.sources){ensure(75);para(`${s.id} · ${s.title}`,{bold:true});para(`Retrieved ${new Date(s.retrieved).toLocaleString()} · ${s.read_full?'Read as evidence':'Discovery / visual only'}`,{size:8,color:muted});if(/^https?:/i.test(s.url))doc.font(regular).fontSize(8).fillColor('#2564db').text(s.url,{width,link:s.url,underline:true});else para('Document added by the user to this project.',{size:8,color:muted});doc.moveDown(.8);}
  heading('Research limitations');para(data.limitations,{size:9,color:muted});
  const range=doc.bufferedPageRange();for(let i=range.start;i<range.start+range.count;i++){doc.switchToPage(i);const bottom=doc.page.margins.bottom;doc.page.margins.bottom=0;doc.font(regular).fontSize(8).fillColor(muted);const y=doc.page.height-32;doc.text('AHJ Atlas · '+data.project.name.slice(0,65),48,y,{width:430,lineBreak:false});doc.text(`${i+1} / ${range.count}`,500,y,{width:45,lineBreak:false});doc.page.margins.bottom=bottom;}
  doc.end();return finished;
}
