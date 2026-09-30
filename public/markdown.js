// A small Markdown renderer for chat answers. It escapes all text before adding
// its own tags, so model output can never supply HTML, attributes or script URLs.
// It has no DOM dependency, so the page and the Node tests share it.
// Private-use characters U+E000 and U+E001 pass through unchanged for the page's
// citation markers; U+0002 and U+0003 are reserved for internal placeholders.
export const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

const fence=/^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const heading=/^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const rule=/^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const quote=/^ {0,3}> ?/;
const delimiter=/^ *\|? *:?-+:? *(?:\| *:?-+:? *)*\|? *$/;
// A table needs a pipe in its delimiter row and the same column count as its header.
const tableStart=(lines,i)=>i+1<lines.length&&lines[i].includes('|')&&lines[i+1].includes('|')&&delimiter.test(lines[i+1])&&cells(lines[i]).length===cells(lines[i+1]).length;
const indentOf=line=>line.match(/^ */)[0].length;
function listItem(line){
  const m=line.match(/^( *)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/);
  return m?{indent:m[1].length,ordered:/\d/.test(m[2]),start:parseInt(m[2],10),text:m[3],width:m[1].length+m[2].length+1}:null;
}
// Inside a paragraph, only a numbered list starting at 1 begins a list, so a line such as
// "2024. The code…" stays text.
const blockStart=(lines,i)=>{const item=listItem(lines[i]);return fence.test(lines[i])||heading.test(lines[i])||rule.test(lines[i])||quote.test(lines[i])||Boolean(item&&(!item.ordered||item.start===1))||tableStart(lines,i);};

function inline(text,references){
  const tokens=[],hold=html=>`\u0002${tokens.push(html)-1}\u0003`;
  // Code spans first, so nothing inside them is formatted.
  let out=String(text).replace(/[\u0002\u0003]/g,'').replace(/(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g,(m,ticks,code)=>hold(`<code>${escapeHtml(code.trim())}</code>`));
  out=out.replace(/\[([^\]\n]{1,300})\]\((https?:\/\/[^\s()<>]+)\)/g,(m,label,url)=>hold(`<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${emphasis(escapeHtml(label))}</a>`));
  out=out.replace(/https?:\/\/[^\s<>()"'`\u0002\u0003]*[^\s<>()"'`.,;:!?\u0002\u0003]/g,url=>hold(`<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`));
  if(references)out=out.replace(/\[(S\d{1,6})\]/g,(m,id)=>{const html=references(id);return typeof html==='string'?hold(html):m;});
  out=emphasis(escapeHtml(out));
  // A link label can hold a code span, so restore placeholders until none remain.
  for(let pass=0;pass<3&&/\u0002\d+\u0003/.test(out);pass++)out=out.replace(/\u0002(\d+)\u0003/g,(m,n)=>tokens[n]??'');
  return out;
}
function emphasis(html){
  return html
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g,'<strong>$1</strong>')
    .replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g,'$1<strong>$2</strong>')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g,'<del>$1</del>')
    .replace(/(^|[^\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])/g,'$1<em>$2</em>')
    .replace(/(^|[^\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/g,'$1<em>$2</em>');
}
function cells(line){
  let row=line.trim();
  // A citation marker after the closing pipe belongs to the last cell.
  const tail=row.match(/(?:\s*\d+)+$/)?.[0]||'';
  row=row.slice(0,row.length-tail.length).trim();
  if(row.startsWith('|'))row=row.slice(1);
  if(row.endsWith('|')&&!row.endsWith('\\|'))row=row.slice(0,-1);
  const out=[];let cell='',ticks=0;
  for(let i=0;i<row.length;i++){
    const c=row[i];
    if(c==='\\'&&row[i+1]==='|'){cell+='|';i++;continue;}
    if(c==='`')ticks^=1;
    if(c==='|'&&!ticks){out.push(cell.trim());cell='';continue;}
    cell+=c;
  }
  out.push(cell.trim());
  if(tail)out[out.length-1]+=tail.trim();
  return out;
}
function table(lines,i,references){
  const head=cells(lines[i]),align=cells(lines[i+1]).map(c=>c.startsWith(':')&&c.endsWith(':')?'center':c.endsWith(':')?'right':'');
  const rows=[];i+=2;
  while(i<lines.length&&lines[i].trim()&&lines[i].includes('|')){rows.push(cells(lines[i]));i++;}
  const cell=(tag,text,n)=>`<${tag}${align[n]?` class="align-${align[n]}"`:''}>${inline(text,references)}</${tag}>`;
  const html=`<div class="chat-table"><table><thead><tr>${head.map((c,n)=>cell('th',c,n)).join('')}</tr></thead><tbody>${rows.map(r=>`<tr>${head.map((_,n)=>cell('td',r[n]??'',n)).join('')}</tr>`).join('')}</tbody></table></div>`;
  return {html,next:i};
}
function list(lines,i,references){
  const first=listItem(lines[i]),base=first.indent,items=[];
  while(i<lines.length){
    const item=listItem(lines[i]);
    if(!item||item.ordered!==first.ordered||item.indent>base+1||item.indent<base)break;
    const body=[item.text];i++;
    while(i<lines.length){
      const line=lines[i];
      if(!line.trim()){
        let j=i;while(j<lines.length&&!lines[j].trim())j++;
        const next=j<lines.length?listItem(lines[j]):null;
        // A blank line before a sibling item keeps the list going.
        if(next&&next.indent<=base+1&&next.indent>=base&&next.ordered===first.ordered){i=j;break;}
        if(j<lines.length&&indentOf(lines[j])>base+1){body.push('');i++;continue;}
        break;
      }
      const next=listItem(line);
      if(next&&next.indent<=base+1)break;
      if(indentOf(line)>base){body.push(line.slice(Math.min(indentOf(line),item.width)));i++;continue;}
      if(blockStart(lines,i))break;
      body.push(line.trim());i++;
    }
    const blocks=parse(body,references);
    items.push(blocks.map((b,n)=>n===0&&b.type==='p'?b.inner:b.html).join(''));
    if(i<lines.length&&!lines[i].trim())break;
  }
  const tag=first.ordered?'ol':'ul',start=first.ordered&&first.start!==1&&Number.isSafeInteger(first.start)?` start="${first.start}"`:'';
  return {html:`<${tag}${start}>${items.map(item=>`<li>${item}</li>`).join('')}</${tag}>`,next:i};
}
function parse(lines,references){
  const blocks=[];let i=0;
  while(i<lines.length){
    const line=lines[i];
    if(!line.trim()){i++;continue;}
    let m;
    if((m=line.match(fence))){
      const code=[];i++;
      while(i<lines.length&&!(lines[i].trim().startsWith(m[1][0].repeat(m[1].length))&&!lines[i].trim().replace(/[`~]/g,'')))code.push(lines[i++]);
      i++;blocks.push({type:'code',html:`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`});continue;
    }
    if((m=line.match(heading))){const level=Math.min(6,m[1].length+2);blocks.push({type:'h',html:`<h${level}>${inline(m[2],references)}</h${level}>`});i++;continue;}
    if(rule.test(line)){blocks.push({type:'hr',html:'<hr>'});i++;continue;}
    if(tableStart(lines,i)){const t=table(lines,i,references);blocks.push({type:'table',html:t.html});i=t.next;continue;}
    if(quote.test(line)){
      const inner=[];while(i<lines.length&&quote.test(lines[i]))inner.push(lines[i++].replace(quote,''));
      blocks.push({type:'quote',html:`<blockquote>${parse(inner,references).map(b=>b.html).join('')}</blockquote>`});continue;
    }
    if(listItem(line)){const l=list(lines,i,references);blocks.push({type:'list',html:l.html});i=l.next;continue;}
    const text=[line.trim()];i++;
    while(i<lines.length&&lines[i].trim()&&!blockStart(lines,i))text.push(lines[i++].trim());
    const inner=text.map(t=>inline(t,references)).join('<br>');
    blocks.push({type:'p',inner,html:`<p>${inner}</p>`});
  }
  return blocks;
}
// references(id) returns trusted HTML for a source reference such as [S1], or null to leave the text.
export function renderMarkdown(text,{references}={}){
  const lines=String(text??'').replace(/\r\n?/g,'\n').replace(/[\u0000\u0001\u0004-\u0008\u000b\u000c\u000e-\u001f]/g,'').replace(/\t/g,'    ').split('\n');
  return parse(lines,references).map(b=>b.html).join('');
}
