import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../lib/store.mjs';
import { Engine } from '../lib/engine.mjs';
import { costMicros, reserveMicros, LIMITS } from '../lib/config.mjs';
import { validateReport, researchPayload } from '../lib/prompts.mjs';
import { isPublicIP, validatePublicUrl, htmlText, isUnitedStates, ResearchTools, searchLocation, searchTool } from '../lib/research-tools.mjs';
import { STATES, PROVINCES, PROVINCE_TIMEZONES } from '../public/location.js';
import { selectPassages } from '../lib/evidence.mjs';
import { ProviderError } from '../lib/provider.mjs';
import { input, evidenceText, report, FakeProvider, fakeTools } from './fixtures.mjs';

function setup(t){const dir=mkdtempSync(path.join(os.tmpdir(),'ahj-atlas-test-')),store=new Store(dir);t.after(()=>{store.close();assert.ok(path.resolve(dir).startsWith(path.join(os.tmpdir(),'ahj-atlas-test-')));rmSync(dir,{recursive:true,force:true});});return store;}
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function settle(engine){for(let i=0;i<150;i++){await wait(5);if(!engine.running.size&&!engine.polling.size&&!engine.applying.size)return;}throw new Error('Engine did not settle');}
async function runToReport(engine,store,id){for(let i=0;i<40;i++){await engine.tick();await settle(engine);const p=store.project(id);if(p.report)return p;if(['attention','budget','failed'].includes(p.status))throw new Error(p.note);}throw new Error('Report did not finish');}

test('cache-aware billing applies batch discount only to tokens',()=>{
  const u={input_tokens:100000,output_tokens:20000,cache_read_input_tokens:100000,cache_creation_input_tokens:999999,cache_creation:{ephemeral_5m_input_tokens:50000,ephemeral_1h_input_tokens:10000},server_tool_use:{web_search_requests:10}};
  assert.equal(costMicros(u,'research','realtime'),675000);assert.equal(costMicros(u,'research','batch'),387500);
  assert.equal(costMicros({cache_read_input_tokens:100000},'review'),20000);
});
test('continuing a completed report only reopens research for a substantive follow-up',async t=>{
  const s=setup(t),p=s.create(input),engine=new Engine(s,new FakeProvider(),()=>null,{autoStart:false});
  engine.tick=async()=>{};
  for(const stage of s.stages(p.id))s.updateStage(p.id,stage.id,{status:'complete'});
  await engine.resume(p.id,{clarification:'   \n  '});
  assert.ok(s.stages(p.id).filter(stage=>stage.id!=='review').every(stage=>stage.status==='complete'));
  assert.equal(s.stages(p.id).find(stage=>stage.id==='review').status,'queued');
  await engine.resume(p.id,{clarification:'Please investigate the unresolved fire district boundary.'});
  assert.ok(s.stages(p.id).every(stage=>stage.status==='queued'));
  assert.match(s.project(p.id).input.notes,/unresolved fire district boundary/);
});
test('pending estimates are recorded without limiting new requests',t=>{
  const s=setup(t),p=s.create({...input,budget:1});
  s.reserve(p.id,'jurisdiction',{mode:'realtime',modelKey:'research',payload:{},reserve:600000});
  s.reserve(p.id,'contacts',{mode:'realtime',modelKey:'research',payload:{},reserve:50000000});
  assert.equal(s.project(p.id).reserved,50.6);assert.ok(!Object.hasOwn(s.project(p.id),'budget'));assert.deepEqual(s.settings(),{});
  assert.doesNotMatch(s.events(p.id).at(-1).message,/allowance|budget/);
});
test('global search allocations are reserved across simultaneous stages',t=>{
  const s=setup(t),p=s.create(input),payload={tools:[{name:'web_search',max_uses:LIMITS.searches/2+5}]};
  s.reserve(p.id,'jurisdiction',{mode:'batch',modelKey:'research',payload,reserve:1000});
  assert.throws(()=>s.reserve(p.id,'codes',{mode:'batch',modelKey:'research',payload,reserve:1000}),/SEARCH_BUDGET/);
});
test('estimated spending counts charges recorded today, including prior-day batches and deleted projects',t=>{
  const s=setup(t);s.setSettings({dailyBudget:1});const p=s.create(input),a=s.reserve(p.id,'jurisdiction',{mode:'batch',modelKey:'research',payload:{},reserve:800000});
  s.db.prepare('UPDATE attempts SET created=? WHERE id=?').run('2020-01-01T00:00:00.000Z',a.id);
  assert.deepEqual(s.spending(),{today:0,total:0,pending:.8});
  s.updateAttempt(a.id,{state:'settled',actual:800000});s.reserve(p.id,'codes',{mode:'batch',modelKey:'research',payload:{},reserve:300000});
  assert.deepEqual(s.spending(),{today:.8,total:.8,pending:.3});
  const old=s.create({...input,name:'Older project'}),b=s.reserve(old.id,'jurisdiction',{mode:'realtime',modelKey:'research',payload:{},reserve:1});
  s.updateAttempt(b.id,{state:'settled',actual:200000,applied:1});s.db.prepare('UPDATE attempts SET charged_at=? WHERE id=?').run('2020-01-01T00:00:00.000Z',b.id);s.deleteProject(old.id);
  assert.deepEqual(s.spending(),{today:.8,total:1,pending:.3});assert.deepEqual(s.settings(),{});
});
test('projects stopped at a former spending limit wait for an explicit continue after upgrade',t=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'ahj-atlas-test-'));t.after(()=>{assert.ok(path.resolve(dir).startsWith(path.join(os.tmpdir(),'ahj-atlas-test-')));rmSync(dir,{recursive:true,force:true});});
  const s=new Store(dir),p=s.create(input),other=s.create({...input,name:'Running project'});
  s.db.prepare("UPDATE projects SET status='budget',note='Increase the project budget.',final_hold=2480000,budget=5000000 WHERE id=?").run(p.id);
  s.db.prepare("UPDATE projects SET status='researching',final_hold=1390000 WHERE id=?").run(other.id);
  s.db.prepare('UPDATE settings SET data=? WHERE id=1').run('{"defaultBudget":5,"dailyBudget":20}');s.close();
  const reopened=new Store(dir);try{
    const q=reopened.project(p.id);assert.equal(q.status,'attention');assert.match(q.note,/Continue research/);assert.equal(reopened.project(other.id).status,'researching');
    assert.equal(reopened.db.prepare('SELECT SUM(final_hold) n FROM projects').get().n,0);assert.deepEqual(reopened.settings(),{});assert.ok(!Object.hasOwn(q,'budget'));
  }finally{reopened.close();}
});
test('search discovery followed by repeated source reading preserves IDs and provenance',t=>{
  const s=setup(t),p=s.create(input),url='https://example.com/adoption';
  const found=s.source(p.id,{url,title:'Search',text:'Unretrieved secret adoption quotation.'});
  const read=s.source(p.id,{url,title:'Read',text:evidenceText,readFull:true});
  const later=s.source(p.id,{url,text:'Another genuine retrieved page.',readFull:true});
  s.source(p.id,{url,text:'This later search snippet must not become evidence.'});
  assert.equal(found.id,read.id);assert.equal(read.id,later.id);assert.equal(s.sources(p.id).length,1);
  assert.ok(!s.sources(p.id)[0].text.includes('secret'));assert.ok(!s.sources(p.id)[0].text.includes('later search snippet'));
  assert.ok(s.sources(p.id)[0].text.includes('Another genuine'));
});
test('validation downgrades fabricated citations, conditional jurisdiction, unknown editions, invented URLs and emails',()=>{
  const r=report(),sources=[{id:'S1',url:'https://example.com/adoption',text:evidenceText,read_full:true}];
  r.jurisdiction.evidence[0].quote='Invented jurisdiction quote';r.contacts[0].email='invented@example.com';r.codes[0].edition='Unknown';r.authorities[0].website='https://example.com/invented-path';
  const out=validateReport(r,sources);
  assert.equal(out.jurisdiction.status,'unverified');assert.equal(out.codes[0].status,'unverified');assert.equal(out.contacts[0].email,'');assert.equal(out.authorities[0].website,'');assert.ok(out.gaps.length>=2);
});
test('unknown code edition cannot yield a complete report without questions',()=>{
  const r=report();r.codes[0].edition='';r.codes[0].status='unverified';const out=validateReport(r,[{id:'S1',url:'https://example.com/adoption',text:evidenceText,read_full:true}]);assert.ok(out.gaps.some(g=>g.question.includes('Fixture Building Code')));
});
test('public URL reader rejects loopback, metadata and private targets before network access',async()=>{
  for(const ip of ['127.0.0.1','10.2.3.4','169.254.169.254','172.16.1.1','192.168.1.2','::1','fc00::1','::ffff:7f00:1'])assert.equal(isPublicIP(ip),false,ip);
  assert.equal(isPublicIP('8.8.8.8'),true);assert.equal(isPublicIP('2606:4700:4700::1111'),true);
  for(const url of ['http://127.0.0.1/admin','file:///etc/passwd','https://user:pass@example.com','http://localhost/','https://example.com:444/'])await assert.rejects(validatePublicUrl(url));
});
test('HTML extraction removes active content while retaining source links',()=>{
  const r=htmlText('<title>Agency &amp; office</title><script>steal()</script><p>Adoption text.</p><a href="/codes">Codes</a>','https://example.com/');assert.equal(r.title,'Agency & office');assert.ok(!r.text.includes('steal'));assert.equal(r.links[0].url,'https://example.com/codes');
});
test('project address terms rank passages in accented and non-Latin scripts',()=>{
  const filler='Home Senate Assembly Committees Documents Help\n'.repeat(250);
  const ranked=(address,sentence)=>selectPassages(filler+sentence+'\n'+filler,{limit:1500,input:{address}}).text.includes(sentence);
  assert.ok(ranked('950 Walnut Ridge Dr, Hartland WI','Village of Hartland, Waukesha County — commercial plan review.'));
  assert.ok(ranked('Carrera 7 # 32-16, Bogotá, D.C., Colombia','Aplica en la ciudad de Bogotá, D.C. para revisión de planos.'));
  assert.ok(ranked('1000 Rue Sherbrooke O, Montréal, QC','Service de sécurité incendie de Montréal — examen des plans.'));
  assert.ok(ranked('Av. Constituyentes 100, Querétaro, Qro.','Protección Civil del Estado de Querétaro revisa los planos.'));
  // Unspaced scripts: the address run continues straight into more Japanese or Thai text.
  assert.ok(ranked('〒100-0005 東京都千代田区丸の内1-9-1','所在地は東京都千代田区丸の内一丁目です。'));
  assert.ok(ranked('千代田区 データセンター','新しいデータセンターの防火計画。'));
  assert.ok(ranked('กรุงเทพมหานคร 10110','ศูนย์ข้อมูลในกรุงเทพมหานครแห่งใหม่'));
  assert.ok(ranked('ភ្នំពេញ 12000','មជ្ឈមណ្ឌលទិន្នន័យរាជធានីភ្នំពេញថ្មី'));
  // Combining marks: Devanagari vowel signs, and accents composed or decomposed on either side.
  assert.ok(ranked('नई दिल्ली 110001','नई दिल्ली में नया डेटा सेंटर'));
  for(const [address,text] of [['Bogotá','Bogotá'],['Bogotá','Bogotá'],['Bogotá','Bogotá']])assert.ok(ranked('Carrera 7, '+address+', Colombia','Aplica en la ciudad de '+text+' para revisión.'),address+' / '+text);
  // Unicode edges still reject a longer word, including one continuing with an accented letter.
  assert.equal(ranked('12 Main St, Leon, KS','Registro del distrito Leonés para revisión.'),false);
});
test('Census address lookup accepts common United States spellings only',async t=>{
  for(const c of ['United States','united states of america','US','U.S.','USA','U.S.A.','U. S. A.','America','The United States'])assert.equal(isUnitedStates(c),true,c);
  for(const c of ['Canada','México','South America','Australia','USSR',''])assert.equal(isUnitedStates(c),false,c);
  const s=setup(t),urls=[],tools=new ResearchTools(s,{fetchImpl:async url=>{urls.push(url);return {buffer:Buffer.from('{"result":{"addressMatches":[]}}')};}});
  for(const country of ['U.S.A.','America',''])assert.match(JSON.parse((await tools.locate(s.create({...input,country}).id,{})).text).sourceId,/^S\d+$/,country);
  assert.equal(urls.length,3);assert.ok(urls.every(url=>url.startsWith('https://geocoding.geo.census.gov/')));
  assert.match((await tools.locate(s.create({...input,country:'Canada'}).id,{})).text,/covers the United States/);assert.equal(urls.length,3);
});
test('real-time workflow runs through tools and structured review without paid requests',async t=>{
  const s=setup(t),provider=new FakeProvider(),tools=fakeTools(s),e=new Engine(s,provider,()=>true,{tools,autoStart:false}),p=s.create(input);t.after(()=>e.close());
  const result=await runToReport(e,s,p.id);assert.equal(result.status,'partial');assert.equal(result.report.codes[0].edition,'2021');assert.equal(result.report.contacts[0].email,'plans@example.com');assert.equal(result.sourceCount,1);assert.ok(result.cost>0);assert.equal(result.reserved,0);assert.equal(tools.calls,4);
  const continuation=provider.calls.find(c=>c.messages.length>1);assert.equal(continuation.messages[1].content[0].data,'opaque-test-signature');assert.equal(continuation.messages[1].content[1].content[0].encrypted_content,'opaque-test-source');
});
test('batch workflow continues tools through subsequent batches and imports exact IDs once',async t=>{
  const s=setup(t),provider=new FakeProvider(),e=new Engine(s,provider,()=>true,{tools:fakeTools(s),pollMs:0,autoStart:false}),p=s.create({...input,mode:'batch'});t.after(()=>e.close());
  const result=await runToReport(e,s,p.id);assert.equal(result.status,'partial');assert.ok(provider.batches.size>=7);assert.equal(result.reserved,0);
  const first=[...provider.batches.keys()][0],before=result.cost;await e.importBatch(p.id,first,(await provider.results(first)).data);assert.equal(s.project(p.id).cost,before);
});
test('ambiguous submit retains reservation and never auto-resubmits',async t=>{
  const s=setup(t),provider=new FakeProvider();let calls=0;provider.batch=async()=>{calls++;throw new ProviderError('Timeout',{ambiguous:true});};
  const e=new Engine(s,provider,()=>true,{autoStart:false}),p=s.create({...input,mode:'batch'});t.after(()=>e.close());await e.tick();await settle(e);await e.tick();await settle(e);
  assert.equal(calls,1);assert.equal(s.project(p.id).status,'attention');assert.ok(s.project(p.id).reserved>0);await assert.rejects(e.resume(p.id,{}),/outstanding/);
});
test('cancellation imports completed batch charges without running more tools',async t=>{
  const s=setup(t),provider=new FakeProvider();provider.autoEnd=false;const tools=fakeTools(s),e=new Engine(s,provider,()=>true,{tools,pollMs:0,autoStart:false}),p=s.create({...input,mode:'batch'});t.after(()=>e.close());
  await e.tick();await settle(e);await e.cancel(p.id);await settle(e);await e.tick();await settle(e);assert.equal(s.project(p.id).status,'canceled');assert.ok(s.project(p.id).cost>0);assert.equal(s.project(p.id).reserved,0);assert.equal(tools.calls,0);assert.equal(provider.batches.size,1);
});
test('per-attempt application lock prevents duplicate slow tool execution',async t=>{
  const s=setup(t),provider=new FakeProvider(),p=s.create(input),tools=fakeTools(s),run=tools.run.bind(tools);tools.run=async(...args)=>{await wait(50);return run(...args);};
  const e=new Engine(s,provider,()=>true,{tools,autoStart:false});t.after(()=>e.close());const a=s.reserve(p.id,'jurisdiction',{mode:'realtime',modelKey:'research',payload:researchPayload(s,p,s.stage(p.id,'jurisdiction')),reserve:100000});e.record(a,provider.response(a.payload));const received=s.attempt(a.id);await Promise.all([e.apply(received),e.apply(received)]);assert.equal(tools.calls,1);assert.equal(s.stage(p.id,'jurisdiction').messages.length,3);
});
test('missing usage retains unknown cost instead of treating a response as free',t=>{
  const s=setup(t),p=s.create(input),e=new Engine(s,new FakeProvider(),()=>true,{autoStart:false});t.after(()=>e.close());const a=s.reserve(p.id,'jurisdiction',{mode:'realtime',modelKey:'research',payload:{},reserve:100000});e.record(a,{id:'msg_unknown',content:[],stop_reason:'end_turn'});assert.equal(s.attempt(a.id).state,'unknown');assert.equal(s.project(p.id).reserved,.1);
});
test('restart marks unknown dispatch but preserves known pending batch',t=>{
  const s=setup(t),p=s.create(input);const a=s.reserve(p.id,'jurisdiction',{mode:'batch',modelKey:'research',payload:{},reserve:100000}),b=s.reserve(p.id,'contacts',{mode:'batch',modelKey:'research',payload:{},reserve:100000});s.updateAttempt(b.id,{state:'pending',batch_id:'msgbatch_known'});s.recover();assert.equal(s.attempt(a.id).state,'unknown');assert.equal(s.attempt(b.id).state,'pending');assert.equal(s.project(p.id).reserved,.2);
});
test('truncated tool calls are never executed or labeled complete',async t=>{
  const s=setup(t),p=s.create(input),tools=fakeTools(s),provider=new FakeProvider(),e=new Engine(s,provider,()=>true,{tools,autoStart:false});t.after(()=>e.close());
  const payload=researchPayload(s,p,s.stage(p.id,'jurisdiction')),a=s.reserve(p.id,'jurisdiction',{mode:'realtime',modelKey:'research',payload,reserve:100000});const response=provider.response(payload);response.stop_reason='max_tokens';e.record(a,response);await e.apply(s.attempt(a.id));assert.equal(tools.calls,0);assert.equal(s.stage(p.id,'jurisdiction').status,'queued');assert.equal(s.stage(p.id,'jurisdiction').recoveries,1);
});

test('page reads keep table columns and collect links from menus and footers',()=>{
  const r=htmlText('<nav><a href="/fire">Fire Prevention</a></nav><h1>Adopted codes</h1><table><tr><th>Code</th>\n<th>Edition</th></tr><tr><td>International Fire Code</td>\n  <td>2024</td></tr></table><footer><a href="/permits">Permits</a></footer>','https://city.example.gov/');
  assert.match(r.text,/Code \| Edition/);assert.match(r.text,/International Fire Code \| 2024/);assert.ok(!r.text.includes('Fire Prevention'));assert.ok(!/\|\s*$/m.test(r.text));
  assert.deepEqual(r.allLinks.map(l=>l.url).sort(),['https://city.example.gov/fire','https://city.example.gov/permits']);assert.deepEqual(r.links.map(l=>l.title).sort(),['Fire Prevention','Permits']);
});
test('a page read shows its most relevant links and remembers every link for chat',async t=>{
  const s=setup(t),p=s.create(input),anchors=Array.from({length:150},(_,n)=>`<a href="/doc/${n}">Document ${n}</a>`).join('');
  const tools=new ResearchTools(s,{fetchImpl:async url=>({url,buffer:Buffer.from(`<title>City</title><p>Permit records.</p><nav>${anchors}</nav>`),type:'text/html',modified:''})});
  const result=JSON.parse((await tools.read(p.id,{url:'https://city.example.gov/'})).text);
  assert.equal(result.links.length,LIMITS.pageLinks);assert.equal(s.knownLinks(p.id).length,150);assert.ok(s.knownUrl(p.id,'https://city.example.gov/doc/149'));
});
test('web search is localized to a project city and state or province read from its address',()=>{
  assert.deepEqual(searchLocation({address:'123 Main St, Springfield, IL 62701',country:'United States'}),{type:'approximate',city:'Springfield',region:'Illinois',country:'US'});
  assert.deepEqual(searchLocation({address:'4000 Data Center Way, Mesa, Arizona 85215, USA'}),{type:'approximate',city:'Mesa',region:'Arizona',country:'US'});
  assert.deepEqual(searchLocation({address:'Parcel 12, New Albany OH 43054',country:'USA'}),{type:'approximate',city:'New Albany',region:'Ohio',country:'US'});
  assert.deepEqual(searchLocation({address:'1 Main St, Washington, DC 20001'}),{type:'approximate',city:'Washington',region:'District of Columbia',country:'US'});
  // Every state, DC and Puerto Rico, by code or name, with or without a ZIP, a comma or a trailing country.
  for(const [code,name] of Object.entries(STATES))for(const address of [`100 Main St, Springfield, ${code} 12345`,`100 Main St, Springfield ${name} 12345-6789`,`100 Main St, Springfield, ${name.toUpperCase()}`,`100 Main St, Springfield, ${code.toLowerCase()} 12345, USA`,`100 Main St, Springfield ${code} 12345 United States`])
    assert.deepEqual(searchLocation({address}),{type:'approximate',city:'Springfield',region:name,country:'US'},address);
  // "West Virginia" is not Virginia; "D.C." with periods is the District, not Washington State.
  assert.deepEqual(searchLocation({address:'1 Data Way, Charleston, West Virginia 25301'}),{type:'approximate',city:'Charleston',region:'West Virginia',country:'US'});
  assert.deepEqual(searchLocation({address:'1600 Pennsylvania Ave NW, Washington, D.C. 20500'}),{type:'approximate',city:'Washington',region:'District of Columbia',country:'US'});
  assert.deepEqual(searchLocation({address:'700 Sherman Ave, Coeur d’Alene, ID 83814'}),{type:'approximate',city:'Coeur d’Alene',region:'Idaho',country:'US'});
  assert.deepEqual(searchLocation({address:'1 Marine Dr, Hagåtña, GU 96910'}),{type:'approximate',city:'Hagåtña',region:'Guam',country:'US'});
  for(const address of ['1 Main St, St. Thomas, U.S. Virgin Islands 00802','1 Main St, St. Thomas, US Virgin Islands 00802','1 Main St, St. Thomas VI 00802'])
    assert.deepEqual(searchLocation({address}),{type:'approximate',city:'St. Thomas',region:'Virgin Islands',country:'US'},address);
  // A street line's direction or street type is not a state, unless the street line is the whole address.
  for(const address of ['4500 Main St NE, Albuquerque 87102','12 Oak Ct, Springfield'])assert.deepEqual(searchLocation({address}),{type:'approximate',country:'US'},address);
  assert.deepEqual(searchLocation({address:'21000 Atlantic Blvd Ashburn VA 20147'}),{type:'approximate',region:'Virginia',country:'US'});
  assert.deepEqual(searchLocation({address:'21000 Atlantic Blvd Ashburn VA, 20147'}),{type:'approximate',region:'Virginia',country:'US'});
  // No recognizable state: the country alone. Another country: no location at all.
  assert.deepEqual(searchLocation({address:'100 Test Avenue, Example District, Test State 00000'}),{type:'approximate',country:'US'});
  // A Canadian project sends its city, province and the province's time zone, but no country code.
  const canada=(address,city,region,timezone)=>assert.deepEqual(searchLocation({address,country:'Canada'}),{type:'approximate',...(city?{city}:{}),region,timezone},address);
  canada('1 King St W, Toronto, ON M5H 1A1','Toronto','Ontario','America/Toronto');
  canada('100 Queen St, Ottawa ON K1A0A9','Ottawa','Ontario','America/Toronto');
  canada('1234, rue Sainte-Catherine Ouest, Montréal (Québec) H3G 1P1','Montréal','Quebec','America/Toronto');
  canada('1055 W Georgia St, Vancouver, B.C. V6E 3P3','Vancouver','British Columbia','America/Vancouver');
  canada('200 Main St SW, Calgary, Alberta T2P 1M2','Calgary','Alberta','America/Edmonton');
  canada('10 Main St, Halifax, NS B3H 1A1, Canada','Halifax','Nova Scotia','America/Halifax');
  canada('10 Main St, Toronto, ON, CA','Toronto','Ontario','America/Toronto');
  canada('1 King Street West Toronto Ontario Canada','','Ontario','America/Toronto');
  for(const [region,timezone] of Object.entries(PROVINCE_TIMEZONES)){canada(`1 Main St, Capital, ${region}`,'Capital',region,timezone);assert.ok(Intl.supportedValuesOf('timeZone').includes(timezone),timezone);}
  assert.deepEqual(Object.keys(PROVINCE_TIMEZONES).sort(),Object.values(PROVINCES).sort());
  // No province, or a project saved with another country: no location at all.
  for(const input of [{address:'4500 Centre St NE, Calgary',country:'Canada'},{address:'Toronto',country:'Canada'},{address:'1 Main St, Mexico City',country:'Mexico'}])assert.equal(searchLocation(input),null,input.address);
  assert.ok(!Object.hasOwn(searchTool(4,{address:'Toronto',country:'Canada'}),'user_location'));
  assert.deepEqual(searchTool(4,{address:'1 King St W, Toronto, ON M5H 1A1',country:'Canada'}).user_location,{type:'approximate',city:'Toronto',region:'Ontario',timezone:'America/Toronto'});
  assert.deepEqual(searchTool(4,{address:'123 Main St, Springfield, IL 62701'}),{type:'web_search_20250305',name:'web_search',max_uses:4,allowed_callers:['direct'],user_location:{type:'approximate',city:'Springfield',region:'Illinois',country:'US'}});
});
