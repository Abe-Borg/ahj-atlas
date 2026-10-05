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
