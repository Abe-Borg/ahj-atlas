import JSZip from 'jszip';
import ExcelJS from 'exceljs';

const unreadable=kind=>`This ${kind} file could not be read. Save it as PDF and add that instead.`;
const entities={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"};
const decode=s=>s.replace(/&(?:#x([0-9a-f]+)|#(\d+)|(\w+));/gi,(m,hex,dec,name)=>hex||dec?String.fromCodePoint(parseInt(hex||dec,hex?16:10)):entities[name]??m);

// The text of one WordprocessingML part: each paragraph on its own line and a table row's
// cells joined with " | ", as a web page's table is. Tabs and line breaks inside runs are
// kept; tab stops, deleted tracked changes, the old place of a tracked move, field codes and
// the fallback copy of drawing text are not the document's text and are left out.
function partText(xml){
  let out='',text=false,run=0,cell=0,moved=0;
  for(const [,close,tag,self,chars] of xml.replace(/<mc:Fallback\b[\s\S]*?<\/mc:Fallback>/g,'').matchAll(/<(\/?)w:(\w+)\b[^>]*?(\/?)>|<[^>]*>|([^<]+)/g)){
    if(chars!==undefined){if(text&&!moved)out+=decode(chars);continue;}
    const open=!close&&!self;
    if(tag==='t')text=open;
    else if(tag==='r'){if(open)run++;else if(close)run=Math.max(0,run-1);}
    // A moved passage's source keeps ordinary w:t text, unlike a deletion's w:delText.
    else if(tag==='moveFrom'){if(open)moved++;else if(close)moved=Math.max(0,moved-1);}
    else if(run&&!moved&&!close&&(tag==='tab'||tag==='br'||tag==='cr'||tag==='noBreakHyphen'))out+=tag==='tab'?'\t':tag==='noBreakHyphen'?'-':'\n';
    else if(tag==='p'&&!open)out+=cell?' ':'\n';
    else if(tag==='tc'){if(open)cell++;else if(close){cell=Math.max(0,cell-1);out=out.replace(/[ \t]+$/,'')+' | ';}}
    else if(tag==='tr'&&close)out=out.replace(/ \| $/,'')+'\n';
  }
  return out.replace(/[ \t]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
}
// A Word (.docx) file's text: the headers (a letter's letterhead), the body, footnotes and
// endnotes, then the footers. A header or footer repeated on several page layouts is kept once.
// Automatic list numbering is applied by Word when it lays the page out, so it is not text here.
export async function wordText(buffer){
  let zip;try{zip=await JSZip.loadAsync(buffer);}catch{throw new Error(unreadable('Word'));}
  const body=zip.file('word/document.xml')||zip.file(/^word\/document\d*\.xml$/)[0];
  if(!body)throw new Error(unreadable('Word'));
  const parts=async pattern=>{
    const texts=[];
    for(const file of zip.file(pattern).sort((a,b)=>a.name.localeCompare(b.name,'en',{numeric:true}))){const text=partText(await file.async('string'));if(text&&!texts.includes(text))texts.push(text);}
    return texts.join('\n\n');
  };
  return [await parts(/^word\/header\d*\.xml$/),partText(await body.async('string')),await parts(/^word\/(?:footnotes|endnotes)\.xml$/),await parts(/^word\/footer\d*\.xml$/)].filter(Boolean).join('\n\n');
}

// A number as Excel shows it under the cell's number format, for the formats that carry
// meaning: percentages, currency and unit text ("$", "psi", "gpm"), a fixed number of decimals,
// thousands separators and a separate format for negatives or zero. Formats this does not
// render (conditions, fractions, scientific notation, times) show the stored number.
function numberText(value,format){
  const plain=String(Number(value.toPrecision(15)));
  if(!format||/^general$/i.test(format)||/\[[<>=]/.test(format))return plain;
  const sections=format.split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  let section=sections[0],sign=value<0?'-':'';
  if(value<0&&sections.length>1){section=sections[1];sign='';}
  else if(value===0&&sections.length>2)section=sections[2];
  let out='',pattern='',at=-1,percent=0;
  const until=(char,from)=>{const end=section.indexOf(char,from);return end<0?section.length:end;};
  for(let i=0;i<section.length;){
    const c=section[i];
    if(c==='"'){const end=until('"',i+1);out+=section.slice(i+1,end);i=end+1;}
    else if(c==='\\'){out+=section[i+1]??'';i+=2;}
    else if(c==='_'||c==='*')i+=2;
    else if(c==='['){const end=until(']',i),inner=section.slice(i+1,end);if(inner.startsWith('$'))out+=inner.slice(1).split('-')[0];i=end+1;}
    else if('0#?.,'.includes(c)){if(at<0)at=out.length;else if(at!==out.length)return plain;pattern+=c;i++;}
    else if(c==='%'){percent++;out+=c;i++;}
    else if(/[a-z@\/]/i.test(c))return plain;
    else{out+=c;i++;}
  }
  if(at<0)return sign+out;
  const [whole,fraction='']=pattern.split('.'),count=(s,re)=>(s.match(re)||[]).length;
  let digits=new Intl.NumberFormat('en-US',{useGrouping:/[0#?],[0#?]/.test(whole),minimumIntegerDigits:Math.min(21,Math.max(1,count(whole,/0/g))),minimumFractionDigits:Math.min(20,count(fraction,/0/g)),maximumFractionDigits:Math.min(20,count(fraction,/[0#?]/g))}).format(Math.abs(value)*100**percent/1000**count(whole.match(/,*$/)[0],/,/g));
  if(!whole.includes('0'))digits=digits.replace(/^0(?=\.|$)/,'');
  return sign+out.slice(0,at)+digits+out.slice(at);
}
// A cell as Excel shows its value: a number under its number format, a formula's cached
// result, rich text's characters and a date as YYYY-MM-DD (with the time when it has one).
function cellText(value,format){
  if(value==null)return '';
  if(value instanceof Date)return Number.isNaN(value.getTime())?'':value.toISOString().slice(0,value.getUTCHours()||value.getUTCMinutes()?16:10).replace('T',' ');
  if(typeof value==='number')return Number.isFinite(value)?numberText(value,format):'';
  if(typeof value==='object'){
    if('result' in value)return cellText(value.result,format);
    if(Array.isArray(value.richText))return value.richText.map(r=>r.text??'').join('');
    if('text' in value)return cellText(value.text,format);
    if('error' in value)return String(value.error);
    return '';
  }
  return String(value);
}
// An Excel (.xlsx) workbook's text, sheet by sheet: each row on its own line with its cells
// joined with " | ", numbers as their number format shows them. A merged range's value is kept
// once, in its first cell; empty rows are
// skipped. Hidden sheets are included and labeled as hidden.
export async function excelText(buffer){
  const book=new ExcelJS.Workbook();
  try{await book.xlsx.load(buffer);}catch{throw new Error(unreadable('Excel'));}
  const sheets=[];
  book.eachSheet(sheet=>{
    const rows=[];
    sheet.eachRow(row=>{
      const cells=[];row.eachCell({includeEmpty:true},cell=>cells.push(cell.type===ExcelJS.ValueType.Merge?'':cellText(cell.value,cell.numFmt).replace(/\s*\n\s*/g,' ').trim()));
      while(cells.length&&!cells.at(-1))cells.pop();
      if(cells.length)rows.push(cells.join(' | '));
    });
    if(rows.length)sheets.push(`Sheet: ${sheet.name}${sheet.state==='visible'?'':' (hidden)'}\n${rows.join('\n')}`);
  });
  return sheets.join('\n\n');
}
