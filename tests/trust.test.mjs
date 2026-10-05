import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {FACTS as F,RUNTIME,SHORT_POINTS,SECTIONS,shortHTML,dossierHTML} from '../public/trust.js';
import {MODELS,STAGE_DEFS,LIMITS,CHAT_LIMITS,CHAT_MODES,PRICE_DATE,STREAM_CHARACTERS_PER_TOKEN,cacheTTL,costMicros,usd} from '../lib/config.mjs';
import {DIAGNOSTIC_LIMIT} from '../lib/diagnostics.mjs';
import {Anthropic} from '../lib/provider.mjs';
import {researchPayload,reviewPayload,validateReport} from '../lib/prompts.mjs';
import {chatPayload} from '../lib/chat.mjs';
import {Store} from '../lib/store.mjs';
import {input,report,evidenceText} from './fixtures.mjs';
import {createApp} from '../server.mjs';
const source=file=>readFileSync(new URL('../'+file,import.meta.url),'utf8');

test('quoted settings match executable constants',()=>{
  assert.deepEqual(F.models,MODELS);assert.deepEqual(F.stages,STAGE_DEFS);
  assert.deepEqual(F.research,LIMITS);assert.deepEqual(F.chat,CHAT_LIMITS);assert.deepEqual(F.modes,CHAT_MODES);
  assert.equal(F.streamCharactersPerToken,STREAM_CHARACTERS_PER_TOKEN);
  assert.equal(F.priceDate,PRICE_DATE);assert.equal(F.diagnosticEvents,DIAGNOSTIC_LIMIT);
  assert.equal(F.realtimeCacheTTL,cacheTTL('realtime'));assert.equal(F.batchCacheTTL,cacheTTL('batch'));
  const perMillion=costMicros({input_tokens:F.million},'research');assert.equal(perMillion,MODELS.research.input*F.million);assert.equal(usd(perMillion),MODELS.research.input);
  assert.equal(costMicros({cache_creation_input_tokens:100},'research'),Math.ceil(100*MODELS.research.input*F.shortCacheFactor));
  assert.equal(costMicros({cache_creation:{ephemeral_1h_input_tokens:100}},'research'),Math.ceil(100*MODELS.research.input*F.longCacheFactor));
  assert.equal(costMicros({input_tokens:100},'research','batch'),Math.ceil(100*MODELS.research.input*F.batchFactor));
  assert.equal(costMicros({server_tool_use:{web_search_requests:F.searchUnit}},'research'),F.searchPrice*F.million);
});

// Inline settings have no exported constant. Extract only the exact executable
// arithmetic expression at its use, rather than matching a copy in documentation.
const inlineFacts=[
  ['serverPort','server.mjs',/port=(\d+),provider/],
  ['requestBytes','server.mjs',/if\(size>(\d+)\)/],
  ['workerMs','lib/engine.mjs',/worker.tick_failed[\s\S]*?\}\)\),(\d+)\)/],
  ['researchWorkers','lib/engine.mjs',/this.running.size<(\d+)/],
  ['parallelReads','lib/engine.mjs',/const parallelReads=(\d+)/],
  ['retries','lib/engine.mjs',/tries<=(\d+)/],
  ['retryBaseMs','lib/engine.mjs',/retryAfterMs\|\|0,(\d+)\*2\*\*/],
  ['outputRecoveries','lib/engine.mjs',/stage.recoveries<(\d+)/],
  ['pollMs','lib/engine.mjs',/pollMs=(\d+)/],
  ['keyRetryStartMs','public/app.js',/connectionRetryMs=(\d+)/],
  ['keyRetryMaxMs','public/app.js',/Math.min\(connectionRetryMs\*2,([\d*]+)\)/],
  ['uiRefreshMs','public/app.js',/refreshConnection\(\).catch\(\(\)=>\{\}\);\}\},(\d+)\)/],
  ['chatRefreshMs','public/app.js',/chatFollowing=false;\}\s*\},(\d+)\)/],
  ['updateUiMs','public/app.js',/setInterval\(\(\)=>checkUpdates\(\),([\d*]+)\)/],
  ['updateIntervalMs','desktop/update-check.mjs',/CHECK_INTERVAL_MS=([\d*]+)/],
  ['updateTimeoutMs','desktop/update-check.mjs',/AbortSignal.timeout\((\d+)\)/],
  ['updateDownloadIdleMs','desktop/update-check.mjs',/DOWNLOAD_IDLE_MS=([\d*]+)/],
  ['updateMaxBytes','desktop/update-check.mjs',/MAX_INSTALLER_BYTES=([\d*]+)/],
  ['sourceIdleMs','lib/research-tools.mjs',/req.setTimeout\((\d+)/],
  ['redirects','lib/research-tools.mjs',/if\(redirects>(\d+)\)/],
  ['cacheMs','lib/research-tools.mjs',/Date.now\(\)-cached.time<(\d+)/],
  ['cacheDocuments','lib/research-tools.mjs',/while\(this.cache.size>(\d+)\)/],
  ['sourceCharacters','lib/store.mjs',/documentDate='',limit=(\d+)\}/],
  ['exportCharacters','lib/exports.mjs',/excerpt:text.slice\(0,(\d+)\)/],
  ['sourceViewCharacters','server.mjs',/text:s.text.slice\(0,(\d+)\)/],
  ['renderRequests','lib/research-tools.mjs',/\+\+requests>(\d+)/],
  ['renderBytes','lib/research-tools.mjs',/fetchPublic\(request.url\(\),\{maxBytes:([\d*]+)\}/],
  ['renderStartMs','lib/research-tools.mjs',/disable-features=ServiceWorker'\],timeout:(\d+)/],
  ['renderNavigationMs','lib/research-tools.mjs',/waitUntil:'domcontentloaded',timeout:(\d+)/],
  ['renderIdleMs','lib/research-tools.mjs',/idleTime:(\d+)/],
  ['renderWaitMs','lib/research-tools.mjs',/idleTime:\d+,timeout:(\d+)/],
  ['providerRequestMs','lib/provider.mjs',/timeout=(\d+),jsonl/],
  ['providerStreamMs','lib/provider.mjs',/streamDeadlineMs=([\d*]+)/],
  ['modelsTimeoutMs','lib/provider.mjs',/after_id='\+encodeURIComponent\(after\):''\),\{timeout:(\d+)/],
  ['tokenCountMs','lib/provider.mjs',/method:'POST',body,timeout:(\d+),context,headers:betaHeaders\(payload\)/],
  ['batchSubmitMs','lib/provider.mjs',/params:a.payload\}\)\)\},timeout:(\d+)/],
  ['batchPollMs','lib/provider.mjs',/encodeURIComponent\(id\)\}`,\{timeout:(\d+)/],
  ['batchResultsMs','lib/provider.mjs',/\/results`,\{timeout:(\d+)/],
  ['batchCancelMs','lib/provider.mjs',/\/cancel`,\{method:'POST',timeout:(\d+)/],
  ['modelsPages','lib/provider.mjs',/page<(\d+);page\+\+/],
  ['modelsPageSize','lib/provider.mjs',/\/v1\/models\?limit=(\d+)/],
  ['quoteMin','lib/prompts.mjs',/normalize\(quote\).length>=(\d+)/],
  ['quoteMax','lib/prompts.mjs',/quote:quote.slice\(0,(\d+)\)/],
  ['pageSectionMax','lib/prompts.mjs',/pageOrSection:String\(e.pageOrSection\|\|''\).slice\(0,(\d+)\)/],
  ['pdfDefaultPages','lib/research-tools.mjs',/Number\(input.pageCount\)\|\|(\d+)/],
  ['pdfMaxPages','lib/research-tools.mjs',/Math.min\((\d+),Number\(input.pageCount\)/],
  ['pdfMaxPage','lib/research-tools.mjs',/Math.min\((\d+),Number\(input.page\)/],
  ['previousAddresses','lib/engine.mjs',/p.address\].slice\(-(\d+)\)/],
  ['manualChargeMax','lib/services.mjs',/amount<0\|\|amount>(\d+)/],
];
test('quoted literal bounds match executable sources',()=>{
  for(const [key,file,pattern] of inlineFacts){
    const expression=source(file).match(pattern)?.[1];assert.ok(expression,`Missing executable source for ${key}`);
    assert.match(expression,/^[\d*]+$/);const value=expression.split('*').reduce((a,b)=>a*Number(b),1);
    assert.equal(F[key],value,`${key} drifted from ${file}`);
  }
  assert.equal(F.pdfSearchPages,Number(source('lib/research-tools.mjs').match(/page\+\(query\?(\d+):pageCount-1\)/)?.[1])+1);
  assert.equal(F.serverHost,source('server.mjs').match(/server.listen\(port,'([^']+)'/)[1]);
  assert.equal(new Anthropic(()=> '').base,'https://'+F.hosts.anthropic);
  assert.equal(new URL(source('lib/research-tools.mjs').match(/const url='([^']+geocoder[^']+)'/)[1]).hostname,F.hosts.census);
  assert.equal(new URL(source('desktop/update-check.mjs').match(/RELEASES_API='([^']+)'/)[1]).hostname,F.hosts.updates);
  assert.equal(new URL(source('desktop/update-check.mjs').match(/REPOSITORY='([^']+)'/)[1]).hostname,F.hosts.releaseDownloads);
});

test('quoted storage paths exist in their implementation',()=>{
  for(const [file,name] of [['lib/store.mjs','atlas.sqlite'],['lib/key-vault.mjs','credential.bin'],['desktop/window-state.mjs','window-state.json'],['desktop/update-check.mjs','update-check.json'],['desktop/migration.mjs','migration-decision.json'],['launcher.mjs','server.log']]){assert.ok(source(file).includes(name));assert.ok(dossierHTML().includes(name));}
});

test('payload settings match copy for every new-work stage and chat depth',()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'atlas-trust-facts-')),store=new Store(dir);
  try{
    for(const processing of ['realtime','batch']){
      const project=store.create({...input,mode:processing});
      for(const def of STAGE_DEFS){
        const payload=def.id==='review'?reviewPayload(store,project):researchPayload(store,project,store.stage(project.id,def.id));
        assert.equal(payload.model,F.models[def.model].id);assert.equal(payload.output_config.effort,def.effort);
        assert.equal(payload.thinking.type,'adaptive');assert.equal(Object.hasOwn(payload,'temperature'),false);
        assert.equal(payload.max_tokens,def.id==='review'?F.research.reviewOutput:F.research.output);
        assert.equal(payload.cache_control.ttl,processing==='batch'?F.batchCacheTTL:F.realtimeCacheTTL);
      }
      for(const [mode,def] of Object.entries(F.modes)){
        const turn=store.createChatTurn(project.id,{clientId:mode,message:'Synthetic audit',mode});
        const payload=chatPayload(store,turn);
        assert.equal(payload.model,F.models[def.modelKey].id);assert.equal(payload.output_config.effort,def.effort);
        assert.equal(payload.max_tokens,F.chat.output);assert.equal(payload.cache_control.ttl,F.chat.cacheTTL);
        assert.equal(payload.thinking.type,'adaptive');assert.equal(Object.hasOwn(payload,'temperature'),false);
        store.updateChatTurn(project.id,turn.id,{status:'complete'});
      }
    }
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('trust explanation does not overstate a matching quotation',()=>{
  const sources=[{id:'S1',url:'https://example.com/adoption',text:evidenceText,read_full:true}];
  const data=report();data.jurisdiction.evidence=[{sourceId:'S1',quote:'A fabricated supporting passage',pageOrSection:''}];data.jurisdiction.status='verified';
  const result=validateReport(data,sources);assert.equal(result.jurisdiction.status,'unverified');
  assert.ok(result.gaps.some(g=>g.question.includes('jurisdiction')));
  assert.match(dossierHTML(),/at least one quotation/);assert.match(dossierHTML(),/does NOT prove every field/);
});

test('runtime inventory coverage, five rows and ledger references',()=>{
  const ledger=source('docs/TRUST_CLAIMS.md'),html=dossierHTML();
  const listed=[...ledger.matchAll(/^\| ([UA]\d\d) \|/gm)].map(m=>m[1]);
  assert.deepEqual(RUNTIME.map(r=>r.id),listed);assert.equal(new Set(listed).size,listed.length);
  for(const r of RUNTIME){assert.ok(r.you&&r.runs&&r.sent&&r.ai&&r.bounds);const card=html.split(`data-claim="${r.id}"`)[1].split('</article>')[0];for(const label of ['You do','What runs','What is sent','AI involved','Bounded by'])assert.ok(card.includes(`<dt>${label}</dt>`),r.id+label);}
  for(const id of ['U01','U02','U04','U10','U13','U18','U19','U20','U21','U22','U23','U24','U26','U27','A04','A05','A06'])assert.equal(RUNTIME.find(r=>r.id===id).ai,'None.');
  for(const [id] of SHORT_POINTS)assert.ok(ledger.includes(`| ${id} |`));
  for(const s of SECTIONS)for(const id of s.claim.split(' '))assert.ok(ledger.includes(`| ${id} |`));
  assert.equal(SECTIONS.length,12);assert.equal(SHORT_POINTS.length,7);
  assert.ok(shortHTML().includes("I'm not convinced — show me exactly what runs →"));
  assert.ok(source('public/help.html').includes('data-open-trust'));assert.ok(source('public/index.html').includes('data-open-trust'));
});

test('trust assets local, external references restricted to further reading',()=>{
  const html=dossierHTML()+shortHTML();
  assert.ok(!/<(?:script|img|iframe|link|video|audio|object|embed)\b/i.test(html));assert.match(html,/<svg[^>]+aria-label=/);
  const beforeReading=html.split('class="trust-note trust-reading"')[0];assert.ok(!/href="https?:/i.test(beforeReading));
  const js=source('public/trust.js'),css=source('public/trust.css');
  assert.ok(!/\bfetch\s*\(|XMLHttpRequest|sendBeacon|new WebSocket/.test(js));assert.ok(!/@import|url\s*\(/i.test(css));
  assert.ok(!/import\s+.*?from\s+['"]https?:/.test(js));
  // Behavioral quantities belong in the fact snapshot, not numeric prose literals.
  const prose=[...js.matchAll(/(?:p|note|row)\([^\n]+/g)].map(m=>m[0]).join('\n');
  assert.ok(!/\$\{n\(\d/.test(prose),'Read quantities from FACTS');
});

test('trust assets served through existing local routes',async t=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'atlas-trust-http-'));
  const app=await createApp({dataDir:dir,port:0,worker:false,vaultDir:path.join(dir,'vault')});
  t.after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});
  for(const [url,type] of [['/trust.js','javascript'],['/trust-facts.js','javascript'],['/trust.css','text/css'],['/help','text/html']]){
    const response=await fetch(app.url+url);assert.equal(response.status,200,url);assert.ok(response.headers.get('content-type').includes(type));
    const text=await response.text();assert.ok(text.length>0);
  }
});
