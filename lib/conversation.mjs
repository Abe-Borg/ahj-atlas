// Moves system-role notes into the preceding user turn as reminders, after its tool results.
export function inlineNotes(payload){
  const messages=[];
  for(const m of payload.messages){
    if(m.role!=='system'){messages.push(m);continue;}
    const last=messages.at(-1);messages[messages.length-1]={...last,content:[...(Array.isArray(last.content)?last.content:[{type:'text',text:last.content}]),{type:'text',text:`<system-reminder>${m.content}</system-reminder>`}]};
  }
  return {...payload,messages};
}
export const rejectsSystemRole=e=>e?.status===400&&/role '?system'? is not supported/i.test(String(e.message));
// A server tool requested alongside a lookup waits for the lookup results. Until it
// runs, the next request must carry only tool_result blocks and no harness notes.
export const pendingServerTool=blocks=>{const done=new Set(blocks.filter(b=>typeof b.type==='string'&&b.type.endsWith('_tool_result')&&b.tool_use_id).map(b=>b.tool_use_id));return blocks.some(b=>b.type==='server_tool_use'&&!done.has(b.id));};
// A turn that fell back to another model is sent back as the API documents: the fallback block
// stays where it was, and thinking, connector text, client tool calls and unanswered server tool
// calls before the last fallback block are dropped, since the model that continued never saw
// them. Only the calls after that block are run. A turn without a fallback block is unchanged.
export function echoContent(blocks){
  const last=blocks.findLastIndex(b=>b?.type==='fallback');
  if(last<0)return blocks;
  const answered=new Set(blocks.filter(b=>typeof b?.type==='string'&&b.type.endsWith('_tool_result')&&b.tool_use_id).map(b=>b.tool_use_id));
  return blocks.filter((b,i)=>i>=last||!['thinking','redacted_thinking','connector_text','tool_use'].includes(b?.type)&&!(b?.type==='server_tool_use'&&!answered.has(b.id)));
}
// Text a fallback model continues is one answer split at the handoff, so it is joined without a separator.
export const responseText=blocks=>blocks.filter(b=>b?.type==='text').map(b=>b.text).join(blocks.some(b=>b?.type==='fallback')?'':'\n');
