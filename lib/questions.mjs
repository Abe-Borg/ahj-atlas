import { createHash } from 'node:crypto';

// Stable across report ordering and whitespace changes, without guessing whether
// differently worded research questions have the same meaning.
export function questionId(question) {
  return createHash('sha256').update(String(question).normalize('NFKC').replace(/\s+/g,' ').trim().toLowerCase()).digest('hex').slice(0,32);
}
export function projectQuestions(report, responses) {
  const questions=new Map();
  for(const gap of report?.gaps||[]) {
    const id=questionId(gap.question),saved=responses.find(r=>r.id===id);
    questions.set(id,{...gap,id,status:'open',answer:'',...saved,question:gap.question});
  }
  // Retain user contributions even when a later report omits the question.
  for(const response of responses)if(!questions.has(response.id))questions.set(response.id,response);
  return [...questions.values()];
}
export function questionContext(responses) {
  return responses.map(({id,question,status,answer})=>({id,question,status,answer:status==='answered'?answer:''})).sort((a,b)=>a.id.localeCompare(b.id));
}
