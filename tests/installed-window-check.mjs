// Read-only checks against a disposable installed app launched with a CDP port.
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';

const version=process.argv[2],port=Number(process.argv[3]||9224);
assert.match(version||'',/^\d+\.\d+\.\d+$/);
const browser=await puppeteer.connect({browserURL:`http://127.0.0.1:${port}`});
try{
  const page=(await browser.pages()).find(p=>/^http:\/\/127\.0\.0\.1:\d+\//.test(p.url()));
  assert.ok(page,'The installed app window did not open.');
  const result=await page.evaluate(async()=>{
    const bootstrap=await(await fetch('/api/bootstrap')).json();
    const projects=await(await fetch('/api/projects')).json();
    const selected=projects.find(p=>p.name==='Electron synthetic report');
    const detail=await(await fetch(`/api/projects/${selected?.id}`)).json();
    const diagnostics=await(await fetch('/api/diagnostics',{method:'POST',headers:{'Content-Type':'application/json','X-App-Token':bootstrap.token},body:'{}'})).json();
    const exports={};
    for(const format of ['pdf','xlsx','json']){
      const response=await fetch(`/api/projects/${selected.id}/export?format=${format}`);
      const bytes=new Uint8Array(await response.arrayBuffer());
      exports[format]={status:response.status,length:bytes.length,magic:Array.from(bytes.slice(0,5))};
    }
    const downloaded=await fetch('/api/diagnostics/download');
    return {rendererNode:typeof process,rendererRequire:typeof require,version:bootstrap.version,
      keyConfigured:bootstrap.keyConfigured,browserAvailable:bootstrap.browserAvailable,
      settings:bootstrap.settings,spending:bootstrap.spending,projects:projects.map(p=>p.name),report:detail.project.report?.summary,
      sources:detail.sources.length,chatTurns:detail.chat?.turns?.length,
      question:detail.project.questions.find(q=>q.question.includes('synthetic office')),
      diagnosticVersion:diagnostics.application?.version,diagnosticCount:diagnostics.events?.length,
      diagnosticsDownload:{status:downloaded.status,length:(await downloaded.arrayBuffer()).byteLength},exports};
  });
  assert.equal(result.rendererNode,'undefined');
  assert.equal(result.rendererRequire,'undefined');
  assert.equal(result.version,version);
  assert.equal(result.diagnosticVersion,version);
  assert.equal(result.keyConfigured,true);
  assert.equal(result.browserAvailable,true);
  assert.ok(result.projects.includes('Electron synthetic report'));
  assert.match(result.report,/Synthetic workflow verification/);
  assert.ok(result.sources>=2);
  assert.ok(result.chatTurns>=1);
  assert.equal(result.question?.status,'answered');
  assert.deepEqual(result.settings,{});
  assert.ok(Number.isFinite(result.spending?.total));
  assert.ok(result.diagnosticCount>=1);
  assert.deepEqual(result.exports.pdf.magic,[37,80,68,70,45]);
  assert.deepEqual(result.exports.xlsx.magic.slice(0,2),[80,75]);
  assert.equal(result.exports.json.status,200);
  assert.equal(result.diagnosticsDownload.status,200);
  assert.ok(result.diagnosticsDownload.length>0);
  assert.notEqual(new URL(page.url()).port,'4318');
  console.log(JSON.stringify({version,port:new URL(page.url()).port,projects:result.projects.length,sources:result.sources,chatTurns:result.chatTurns,question:result.question?.status,diagnostics:result.diagnosticCount,credential:'loaded',exports:result.exports,diagnosticsDownload:result.diagnosticsDownload},null,2));
}finally{browser.disconnect();}
