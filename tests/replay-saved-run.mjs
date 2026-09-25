// Optional read-only regression replay. Never instantiates the worker or provider.
import {DatabaseSync} from 'node:sqlite';
import {evidencePackage,validateReport} from '../lib/prompts.mjs';
import {checkpointFromMessages} from '../lib/evidence.mjs';
import {decodeReport} from '../lib/report-format.mjs';

const id=process.argv[2];if(!id)throw new Error('Usage: node tests/replay-saved-run.mjs <project-id> [database-path]');
const db=new DatabaseSync(process.argv[3]||'data/atlas.sqlite',{readOnly:true});
try{
  const project=db.prepare('SELECT * FROM projects WHERE id=?').get(id);if(!project)throw new Error('Saved project not found.');project.input=JSON.parse(project.input);
  const sources=db.prepare('SELECT * FROM sources WHERE project_id=?').all(id).map(s=>({...s,id:s.id.split(':').at(-1),read_full:Boolean(s.read_full)}));
  const stages=db.prepare('SELECT * FROM stages WHERE project_id=? ORDER BY ordinal').all(id).map(s=>({...s,messages:JSON.parse(s.messages),checkpoint:JSON.parse(s.checkpoint||'{}')}));
  for(const stage of stages)stage.checkpoint=checkpointFromMessages(stage,stage.messages,sources);
  const store={sources:()=>sources,stages:()=>stages,stage:(_,name)=>stages.find(s=>s.id===name)};
  const last=db.prepare("SELECT response,payload FROM attempts WHERE project_id=? AND stage_id='review' AND response IS NOT NULL ORDER BY created DESC LIMIT 1").get(id);
  const priorBlocks=last?JSON.parse(last.payload).messages[0].content:null;
  const priorContent=Array.isArray(priorBlocks)?priorBlocks.filter(b=>b.type==='text').map(b=>b.text).join('\n'):priorBlocks;
  // Support both original JSON-only requests and explicitly delimited evidence.
  const oldPackage=priorContent?JSON.parse(priorContent.match(/^<evidence_package>\n([\s\S]*?)\n<\/evidence_package>/)?.[1]||priorContent):null;
  const packages=[220000,80000,30000].map(budget=>{
    const pack=evidencePackage(store,project,budget);
    return {sourceCharacterBudget:budget,selectedCharacters:pack.sources.reduce((n,s)=>n+s.text.length,0),packageCharacters:JSON.stringify(pack).length,sources:pack.sources.filter(s=>s.text).map(s=>({id:s.id,availableCharacters:s.availableCharacters,previouslyIncludedCharacters:oldPackage?.sources?.find(x=>x.id===s.id)?.text?.length??null,includedCharacters:s.text.length,spans:s.spans}))};
  });
  let validation=null;if(last){
    const response=JSON.parse(last.response),wire=JSON.parse(response.content.filter(c=>c.type==='text').map(c=>c.text).join(''));
    const original=wire.items?decodeReport(wire):wire,updated=validateReport(structuredClone(original),sources,stages,[],project.input),saved=JSON.parse(project.report||'null');
    validation={changedFindings:['codes','fireStandards'].flatMap(section=>(updated[section]||[]).flatMap(row=>{
      const before=saved?.[section]?.find(x=>x.name===row.name);return before&&before.status!==row.status?[{name:row.name,previousStatus:before.status,currentStatus:row.status}]:[];
    })),researchHealth:updated.researchHealth};
  }
  console.log(JSON.stringify({projectId:id,readOnly:true,providerRequests:0,packages,validation},null,2));
}finally{db.close();}
