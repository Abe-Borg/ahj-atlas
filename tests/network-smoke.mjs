import { Store } from '../lib/store.mjs';
import { ResearchTools } from '../lib/research-tools.mjs';
import { mkdtempSync,rmSync,writeFileSync,mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { input } from './fixtures.mjs';
const dir=mkdtempSync(path.join(os.tmpdir(),'ahj-atlas-smoke-')),store=new Store(dir),p=store.create(input),tools=new ResearchTools(store),result={};
try{
  const html=await tools.read(p.id,{url:'https://example.com'});result.html=JSON.parse(html.text).text.length;
  const browser=await tools.render(p.id,{url:'https://example.com'});result.browser=JSON.parse(browser.text).text.length;
  const url='https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf';
  const pdf=await tools.read(p.id,{url});result.pdfText=JSON.parse(pdf.text).text.trim();
  const image=await tools.inspectPdf(p.id,{url,page:1});result.pdfImageBytes=Buffer.from(image.image,'base64').length;
  console.log(JSON.stringify(result));
}finally{store.close();if(path.resolve(dir).startsWith(path.join(os.tmpdir(),'ahj-atlas-smoke-')))rmSync(dir,{recursive:true,force:true});}
