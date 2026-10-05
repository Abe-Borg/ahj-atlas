import { fireProfile } from '../lib/fire-protection.mjs';
import { encodeReport } from '../lib/report-format.mjs';
export const evidenceText='The Example District is the authority for 100 Test Avenue. The district adopts the Fixture Building Code, 2021 edition, effective January 1, 2022. The public contact is Example Plans Office, plans@example.com, telephone 555-0100. These are synthetic test records, not real regulatory findings.';
export const input={name:'Workflow verification · synthetic data',address:'100 Test Avenue, Example District, Test State 00000',discipline:'Fire protection',country:'United States',scope:'Renovation / alteration',occupancy:'Office',permitDate:'2026-10-01',mode:'realtime'};
export function report(){const e=[{sourceId:'S1',quote:'The Example District is the authority for 100 Test Avenue.',pageOrSection:'Test fixture'}];return {
  summary:'Synthetic workflow verification. This is not project guidance.',
  jurisdiction:{description:'Example District — synthetic jurisdiction.',authority:'Example District',status:'verified',notes:'Synthetic data only.',evidence:e},
  authorities:[{name:'Example District',responsibility:'Synthetic review authority',website:'https://example.com/adoption',phone:'555-0100',email:'plans@example.com',address:'100 Test Avenue',status:'verified',evidence:e}],
  contacts:[{name:'',title:'Plans office',organization:'Example Plans Office',responsibility:'Synthetic contact for workflow testing',email:'plans@example.com',phone:'555-0100',address:'100 Test Avenue',website:'https://example.com/adoption',notes:'Not a real contact.',status:'verified',evidence:[{sourceId:'S1',quote:'The public contact is Example Plans Office, plans@example.com, telephone 555-0100.',pageOrSection:'Test fixture'}]}],
  codes:[{name:'Fixture Building Code',edition:'2021',authority:'Example District',adoptionType:'direct',adoptionInstrument:'Synthetic test record',effectiveDate:'2022-01-01',amendments:'Synthetic data; not applicable to design.',applicability:'Workflow testing only',notes:'Not a real code adoption.',status:'verified',evidence:[{sourceId:'S1',quote:'The district adopts the Fixture Building Code, 2021 edition, effective January 1, 2022.',pageOrSection:'Test fixture'}]}],
  requirements:[{title:'Confirm actual authority',authority:'Example District',details:'Synthetic report for application tests only.',website:'https://example.com/adoption',status:'inferred',evidence:e}],gaps:[],coverage:{jurisdiction:'Synthetic evidence checked',contacts:'Synthetic contact checked',codes:'Synthetic edition checked',process:'Synthetic fixture only'},
};}
export class FakeProvider{
  constructor(){this.calls=[];this.batches=new Map();this.counter=0;this.autoEnd=true;this.cancelCalls=[];}
  async count(){return 1500;}
  response(payload){
    const usage={input_tokens:1500,output_tokens:400,cache_read_input_tokens:2000,cache_creation_input_tokens:0,server_tool_use:{web_search_requests:0}};
    if(payload.output_config?.format)return {id:'msg_review',type:'message',role:'assistant',model:payload.model,stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify(payload.output_config.format.schema?.properties?.items?encodeReport(report()):report())}],usage};
    if(payload.messages.some(m=>m.role==='user'&&Array.isArray(m.content)&&m.content.some(c=>c.type==='tool_result')))return {id:'msg_brief',stop_reason:'tool_use',role:'assistant',content:[{type:'tool_use',id:'tool_finish',name:'finish_research',input:{...(payload.tools?.find(t=>t.name==='finish_research')?.input_schema?.properties?.standards?{standards:fireProfile(input).map(t=>({standard:t.standard,applicability:'unresolved',finding:'Synthetic fixture has no NFPA adoption evidence; obtain an official adoption table.'}))}:{}),brief:'Example District. S1: “The district adopts the Fixture Building Code, 2021 edition, effective January 1, 2022.” Synthetic data for testing only.',coverage:{jurisdiction:'supported',contacts:'supported',codes:'unresolved',process:'supported'}}}],usage};
    return {id:'msg_tools',stop_reason:'tool_use',role:'assistant',content:[{type:'redacted_thinking',data:'opaque-test-signature'},{type:'web_search_tool_result',tool_use_id:'srvtoolu_fixture',content:[{type:'web_search_result',url:'https://example.com/adoption',title:'Synthetic adoption record',encrypted_content:'opaque-test-source'}]},{type:'tool_use',id:'tool_read',name:'read_source',input:{url:'https://example.com/adoption'}}],usage:{...usage,server_tool_use:{web_search_requests:1}}};
  }
  async message(payload){this.calls.push(payload);return {data:this.response(payload),requestId:'req_'+this.calls.length};}
  async batch(attempts){const id='msgbatch_test'+(++this.counter);this.batches.set(id,{attempts,canceled:false});return {data:{id,processing_status:'in_progress'},requestId:'req_batch'+this.counter};}
  async poll(id){return {data:{id,processing_status:this.autoEnd||this.batches.get(id).canceled?'ended':'in_progress'}};}
  async results(id){return {data:this.batches.get(id).attempts.map(a=>({custom_id:a.id,result:{type:'succeeded',message:this.response(a.payload)}})).reverse()};}
  async cancel(id){this.cancelCalls.push(id);this.batches.get(id).canceled=true;return {data:{id,processing_status:'canceling'}};}
}
export function fakeTools(store){return {calls:0,async run(projectId,name,input){this.calls++;const s=store.source(projectId,{url:input.url||'https://example.com/adoption',title:'Synthetic adoption record',text:evidenceText,readFull:true});return {text:JSON.stringify({sourceId:s.id,text:evidenceText})};}};}

export const nfpaEvidenceText=evidenceText+' Synthetic test ordinance: the Example District adopts NFPA 13, 2019 edition, for sprinkler installations.';
export function nfpaReport(){const r=report();r.fireStandards=[{name:'NFPA 13 — Sprinkler systems',edition:'2019',authority:'Example District (synthetic)',adoptionType:'direct',adoptionInstrument:'Synthetic test ordinance; not an actual adoption.',effectiveDate:'',amendments:'No amendments established by this synthetic example.',applicability:'Sprinkler installation. Example only, not design guidance.',notes:'This row demonstrates the individual edition and evidence display.',status:'verified',applicabilityStatus:'applicable',adoptionSourceId:'S1',editionSourceId:'S1',evidence:[{sourceId:'S1',quote:'the Example District adopts NFPA 13, 2019 edition, for sprinkler installations.',pageOrSection:'Synthetic test ordinance'}]}];return r;}

export const chatResponse=(text='A source-linked answer [S1].',patch={})=>({id:'msg_chat',role:'assistant',stop_reason:'end_turn',content:[{type:'text',text}],usage:{input_tokens:1000,output_tokens:400},...patch});
export const fetchBlocks=(url,source,id='srvtoolu_fetch')=>[
  {type:'server_tool_use',id,name:'web_fetch',input:{url}},
  {type:'web_fetch_tool_result',tool_use_id:id,content:{type:'web_fetch_result',url,content:{type:'document',source,title:'Synthetic fetched document'}}},
];
export async function pdfFetchBlocks(url,text='Synthetic ordinance: the county adopts the 2024 International Fire Code.'){
  const {default:PDFDocument}=await import('pdfkit');
  const buffer=await new Promise(resolve=>{const doc=new PDFDocument(),chunks=[];doc.on('data',c=>chunks.push(c));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.text(text);doc.end();});
  return fetchBlocks(url,{type:'base64',media_type:'application/pdf',data:buffer.toString('base64')});
}
export class ChatProvider {
  constructor(fn){this.fn=fn;this.calls=[];this.preflights=[];this.counted=1000;}
  async preflight(...args){this.preflights.push(args);}
  async count(){return this.counted;}
  async message(payload,options){this.calls.push({payload:structuredClone(payload),options});return {data:this.fn?await this.fn(payload,this.calls.length,options):chatResponse(),requestId:'req_chat_'+this.calls.length};}
}
