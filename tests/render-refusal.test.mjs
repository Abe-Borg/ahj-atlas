import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../lib/store.mjs';
import {ResearchTools} from '../lib/research-tools.mjs';
import {input} from './fixtures.mjs';

// A local site that answers the plain reader's User-Agent with HTTP 403, as CivicPlus city sites
// and codes.iccsafe.org do, and serves a browser. The host wall.test refuses every visitor.
// The renderer's URL validation is replaced so the pinned host resolves to this server; the
// fetch path (used for every other host) is a fake that refuses like the reader would.
test('the renderer opens a site that refuses the reader, and a site that refuses the browser is remembered for its host',async t=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'ahj-render-')),store=new Store(dir),project=store.create({...input,discipline:'Architecture'});
  const hits=[],server=http.createServer((req,res)=>{
    hits.push({host:req.headers.host,url:req.url,agent:req.headers['user-agent']||''});
    if(req.headers.host.startsWith('wall.test')||(req.headers.host.startsWith('gate.test')&&req.url==='/private')||/^AHJAtlas\//.test(req.headers['user-agent']||'')){res.writeHead(403,{'content-type':'text/html'});res.end('<title>Access Denied</title><p>Request blocked.</p>');return;}
    if(req.url==='/big'){res.writeHead(200,{'content-type':'text/html'});res.end('<title>Big</title><p>'+'x'.repeat(6*1024*1024)+'</p>');return;}
    if(req.url==='/go'){res.writeHead(302,{location:`http://other.test:${port}/landing`});res.end();return;}
    if(req.url==='/go-blocked'){res.writeHead(302,{location:`http://blocked.test:${port}/landing`});res.end();return;}
    if(req.url==='/app.js'){res.writeHead(200,{'content-type':'text/javascript'});res.end("document.getElementById('live').textContent='Rendered by script.';");return;}
    res.writeHead(200,{'content-type':'text/html'});
    res.end('<title>City Fire Marshal</title><h1>Fire Marshal</h1><p>The city adopts NFPA 13.</p><p id="live"></p><a href="/permits">Permit applications</a><img src="http://cdn.test/logo.png"><script src="/app.js"></script>');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));store.close();rmSync(dir,{recursive:true,force:true});});
  const fetched=[];
  const tools=new ResearchTools(store,{
    fetchImpl:async url=>{fetched.push(url);if(url.startsWith('http://other.test:'))return {url,type:'text/html',buffer:Buffer.from('<title>Other host</title><p>Served through the fetch path.</p>'),modified:''};throw Object.assign(new Error(`Source returned HTTP 403 for ${url}.`),{httpStatus:403});},
    validateImpl:async value=>{const url=new URL(value);assert.ok(url.hostname.endsWith('.test'));return {url,answers:[{address:'127.0.0.1',family:4}]};},
    // Some CI containers cannot provide the Chromium sandbox; production launch flags are unchanged.
    browserArgs:process.platform==='linux'?['--no-sandbox']:[]});
  const open=`http://open.test:${port}/fire-marshal`;
  await assert.rejects(tools.read(project.id,{url:open}),/HTTP 403 for http:\/\/open\.test:\d+\/fire-marshal\. This site refuses the built-in reader\. Open a web page with render_page/);
  assert.equal(fetched.length,1);
  const rendered=JSON.parse((await tools.render(project.id,{url:open})).text);
  assert.equal(rendered.title,'City Fire Marshal');
  assert.match(rendered.text,/The city adopts NFPA 13\./);
  assert.match(rendered.text,/Rendered by script\./,'the page\'s own script loaded through the browser');
  assert.deepEqual(rendered.links.map(l=>l.url),[`http://open.test:${port}/permits`]);
  assert.equal(store.sources(project.id).find(s=>s.id===rendered.sourceId).kind,'browser');
  // The pinned host saw a browser, not the reader or headless Chrome; the other host went through the fetch path.
  const document=hits.find(h=>h.host===`open.test:${port}`&&h.url==='/fire-marshal'&&h.agent.includes('Chrome/'));
  assert.ok(document,JSON.stringify(hits));assert.ok(!/HeadlessChrome|AHJAtlas/.test(document.agent),document.agent);
  assert.ok(hits.some(h=>h.url==='/app.js'&&h.agent===document.agent));
  assert.deepEqual(fetched,[open,'http://cdn.test/logo.png']);
  // A page refused on its own, while the site's home page opens, is remembered by URL: the host stays open.
  const gate=`http://gate.test:${port}/private`;
  await assert.rejects(tools.render(project.id,{url:gate}),error=>{
    assert.equal(error.message,`Source returned HTTP 403 for ${gate}. This page refuses the research browser as well as the built-in reader, while the site's home page opens. Retrieve this URL with web_fetch, or record an access gap; other pages on gate.test may still open with read_source or render_page.`);
    return true;});
  assert.ok(hits.some(h=>h.host===`gate.test:${port}`&&h.url==='/'),'the home page was probed');
  assert.equal(tools.hostRefusal(gate),null);
  const gateHits=hits.length,gateFetches=fetched.length;
  await assert.rejects(tools.render(project.id,{url:gate}),/refuses the research browser as well as the built-in reader, while the site's home page opens/);
  await assert.rejects(tools.read(project.id,{url:gate}),/while the site's home page opens/);
  assert.equal(hits.length,gateHits);assert.equal(fetched.length,gateFetches);
  assert.equal(JSON.parse((await tools.render(project.id,{url:`http://gate.test:${port}/`})).text).title,'City Fire Marshal');
  // A host that refuses the browser on the page and on its home page is remembered: the reader, the
  // renderer and inspect_pdf fail at once, with the real status and without a request, and point
  // only at web_fetch or an access gap.
  const wall=`http://wall.test:${port}/codes`;
  await assert.rejects(tools.render(project.id,{url:wall}),error=>{
    assert.equal(error.httpStatus,403);
    assert.equal(error.message,`Source returned HTTP 403 for ${wall}. This site refuses the research browser as well as the built-in reader. Retrieve it with web_fetch, or record an access gap; do not retry read_source, render_page or inspect_pdf for wall.test.`);
    return true;});
  const requests=hits.length,fetches=fetched.length;
  for(const url of [wall,`http://wall.test:${port}/permits`]){
    await assert.rejects(tools.render(project.id,{url}),/refuses the research browser/);
    await assert.rejects(tools.read(project.id,{url}),/refuses the research browser/);
    await assert.rejects(tools.inspectPdf(project.id,{url,page:1}),/refuses the research browser/);
  }
  assert.equal(hits.length,requests);assert.equal(fetched.length,fetches);
  // A response over the per-resource cap ends the read, whichever path served it.
  await assert.rejects(tools.render(project.id,{url:`http://open.test:${port}/big`}),/exceeds the 5 MB reading limit/);
  // Another host is not affected.
  assert.equal(JSON.parse((await tools.render(project.id,{url:`http://open.test:${port}/`})).text).title,'City Fire Marshal');
  // A redirect to another host leaves the pinned host: Chrome cannot resolve it, so the fetch path serves it.
  const redirected=JSON.parse((await tools.render(project.id,{url:`http://open.test:${port}/go`})).text);
  assert.equal(redirected.title,'Other host');assert.match(redirected.text,/Served through the fetch path\./);
  assert.ok(fetched.includes(`http://other.test:${port}/landing`));assert.ok(!hits.some(h=>h.host.startsWith('other.test')));
  // A refusal on the redirect target came from the fetch path, not the browser, so the target host is not blocked.
  await assert.rejects(tools.render(project.id,{url:`http://open.test:${port}/go-blocked`}),/HTTP 403 for http:\/\/blocked\.test:\d+\/landing\. This site refuses the built-in reader\. Open a web page with render_page/);
  assert.equal(tools.hostRefusal(`http://blocked.test:${port}/landing`),null);assert.equal(tools.hostRefusal(`http://open.test:${port}/`),null);
});
