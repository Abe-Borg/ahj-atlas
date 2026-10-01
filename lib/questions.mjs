import { createHash } from 'node:crypto';

// Stable across report ordering and whitespace changes, without guessing whether
// differently worded research questions have the same meaning.
export function questionId(question) {
  return createHash('sha256').update(String(question).normalize('NFKC').replace(/\s+/g,' ').trim().toLowerCase()).digest('hex').slice(0,32);
}
// Written when a later report omits an open question. Answered and dismissed rows stay as they are.
export const CLOSURE_REASON='A later research report no longer includes this question.';
const normalize=value=>String(value||'').normalize('NFKC').replace(/\s+/g,' ').trim().toLowerCase();
export function isResolvedStatus(status){return status==='answered'||status==='dismissed'||status==='closed';}
// Question text, plus an answer only when the user saved one. Used by the same
// name and standard-designation check the validators already apply to gap text.
// It does not decide that two wordings are one question; that stays questionId.
export function resolvedQuestionText(response){
  if(!isResolvedStatus(response?.status))return '';
  return [response.question,response.status==='answered'?response.answer:''].filter(Boolean).join('\n');
}
export function resolvedCovers(responses,{question,needle}={}){
  const id=question?questionId(question):'',pin=needle?normalize(needle):'';
  return (responses||[]).some(response=>{
    if(!isResolvedStatus(response.status))return false;
    if(id&&response.id===id)return true;
    return Boolean(pin)&&normalize(resolvedQuestionText(response)).includes(pin);
  });
}
export function projectQuestions(report, responses) {
  const questions=new Map();
  for(const gap of report?.gaps||[]) {
    const id=questionId(gap.question),saved=responses.find(r=>r.id===id);
    questions.set(id,{...gap,id,status:'open',answer:'',reason:'',...saved,question:gap.question});
  }
  // Retain user contributions, including closures, when a later report omits the question.
  for(const response of responses)if(!questions.has(response.id))questions.set(response.id,response);
  return [...questions.values()];
}
// Closures stay on the question row. They are not user context, so recording one
// does not by itself mark the research context out of date.
export function questionContext(responses) {
  return responses.filter(response=>response.status!=='closed').map(({id,question,status,answer})=>({id,question,status,answer:status==='answered'?answer:''})).sort((a,b)=>a.id.localeCompare(b.id));
}
// Open items whose exact question text is absent from the replacement report.
// A reworded gap has a different id and is left open.
export function questionsToClose(previousGaps,nextGaps,responses){
  const nextIds=new Set((nextGaps||[]).filter(gap=>gap?.question).map(gap=>questionId(gap.question)));
  const byId=new Map((responses||[]).map(response=>[response.id,response]));
  const seen=new Set(),closing=[];
  const consider=gap=>{
    const question=String(gap?.question||'').trim();if(!question)return;
    const id=questionId(question);if(seen.has(id)||nextIds.has(id))return;
    seen.add(id);
    const saved=byId.get(id);if(saved&&saved.status!=='open')return;
    closing.push({id,question,why:gap.why||saved?.why||'',contact:gap.contact||saved?.contact||'',nextStep:gap.nextStep||saved?.nextStep||'',answer:saved?.answer||'',reason:CLOSURE_REASON});
  };
  for(const gap of previousGaps||[])consider(gap);
  for(const response of responses||[])if(response.status==='open')consider(response);
  return closing;
}
