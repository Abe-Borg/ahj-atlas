import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { COUNTRIES, countryName, addressCountry, regionIn, PROVINCES, STATES } from '../public/location.js';
import { createApp } from '../server.mjs';
import { Store, projectCountry } from '../lib/store.mjs';
import { Engine } from '../lib/engine.mjs';
import { researchPayload, reviewPayload } from '../lib/prompts.mjs';
import { diagnosticReport } from '../lib/diagnostics.mjs';
import { input, FakeProvider, fakeTools } from './fixtures.mjs';

const TORONTO='1 King St W, Toronto, ON M5H 1A1';
function setup(t){const dir=mkdtempSync(path.join(os.tmpdir(),'ahj-atlas-location-')),store=new Store(dir);t.after(()=>{store.close();assert.ok(path.resolve(dir).startsWith(path.join(os.tmpdir(),'ahj-atlas-location-')));rmSync(dir,{recursive:true,force:true});});return store;}
function engine(t,s){const e=new Engine(s,new FakeProvider(),()=>true,{tools:fakeTools(s),autoStart:false});e.tick=async()=>{};t.after(()=>e.close());return e;}
function complete(s,id){for(const stage of s.stages(id))s.updateStage(id,stage.id,{status:'complete',output:'Brief for the previous location.',rounds:3});}

test('country names normalize to the two supported countries',()=>{
  assert.deepEqual(COUNTRIES,['United States','Canada']);
  for(const value of ['United States','united states of america','US','U.S.','USA','U.S.A.','America'])assert.equal(countryName(value),'United States',value);
  for(const value of ['Canada','CANADA','CA','ca'])assert.equal(countryName(value),'Canada',value);
  for(const value of ['Mexico','México','Puerto Rico','Australia','not united states','United States of Americafoo','Canadian','',null])assert.equal(countryName(value),'',value);
  assert.equal(projectCountry(''),'United States');assert.equal(projectCountry('  '),'United States');assert.equal(projectCountry('U.S.A.'),'United States');assert.equal(projectCountry('canada'),'Canada');
  for(const value of ['Mexico','not united states'])assert.throws(()=>projectCountry(value),/Choose United States or Canada/,value);
});

test('an address reads as Canadian or American only when it says so',()=>{
  const reads=[
    [TORONTO,'Canada',true],['100 Queen St, Ottawa ON K1A0A9','Canada',true],
    ['1234, rue Sainte-Catherine Ouest, Montréal (Québec) H3G 1P1','Canada',true],['1234, rue Sainte-Catherine Ouest, Montréal (Québec)','Canada',false],
    ['1055 W Georgia St, Vancouver, BC','Canada',false],['200 Main St, Calgary, Alberta','Canada',false],['10 Main St, Halifax, NS, Canada','Canada',true],
    ['21000 Atlantic Blvd, Ashburn VA 20147','United States',true],['21000 Atlantic Blvd, Ashburn, VA','United States',false],['21000 Atlantic Blvd, Ashburn, VA, 20147','United States',true],
    ['4000 Data Center Way, Mesa, Arizona 85215, USA','United States',true],
    // A country at the end without a comma before it is read too.
    ['1 King Street West Toronto Ontario Canada','Canada',true],['123 Main St, Springfield IL 62701 United States','United States',true],['123 Main St, Springfield IL 62701 U.S.A.','United States',true],['123 Main St, Springfield IL US','United States',true],['123 Main St, Ontario, CA 91761','United States',true],['100 George St, New Brunswick, NJ 08901','United States',true],
  ];
  for(const [address,country,definite] of reads)assert.deepEqual(addressCountry(address),{country,definite},address);
  // A bare "CA" may be Canada or California; no region, or a road named "US 50", decides nothing.
  for(const address of ['10 Main St, Toronto, Ontario, CA','123 Main St, Ontario, CA',input.address,'4500 Centre St NE, Calgary','12345 Yonge St, Toronto','1 Main St, Somewhere, US 50','5 Rue des us',''])assert.equal(addressCountry(address),null,address);
  assert.deepEqual(regionIn('Montréal (Québec) H3G 1P1',PROVINCES),{region:'Quebec',rest:'Montréal'});
  assert.deepEqual(regionIn('Trois-Rivières QC',PROVINCES),{region:'Quebec',rest:'Trois-Rivières'});
  assert.deepEqual(regionIn('Mesa, Arizona 85215',STATES),{region:'Arizona',rest:'Mesa,'});
  assert.equal(Object.keys(PROVINCES).length,13);assert.ok(Object.keys(PROVINCES).every(code=>!STATES[code]));
});

test('a project is created only in the United States or Canada, with a country that matches its address',async t=>{
  const s=setup(t);
  assert.equal(s.create({...input,country:''}).input.country,'United States');
  assert.equal(s.create({...input,country:'USA'}).input.country,'United States');
  assert.equal(s.create({...input,address:TORONTO,country:'canada'}).input.country,'Canada');
  // An address that names no country is accepted for either.
  assert.equal(s.create({...input,country:'Canada'}).input.country,'Canada');
  const before=s.list().length;
  assert.throws(()=>s.create({...input,country:'Mexico'}),/Choose United States or Canada/);
  assert.throws(()=>s.create({...input,address:TORONTO,country:'United States'}),/appears to be in Canada\. Choose Canada as the country/);
  assert.throws(()=>s.create({...input,address:'21000 Atlantic Blvd, Ashburn VA 20147',country:'Canada'}),/appears to be in the United States\. Choose United States as the country/);
  assert.equal(s.list().length,before);
});

test('correcting the country reopens jurisdiction research and tells research the previous country',async t=>{
  const s=setup(t),e=engine(t,s),p=s.create(input);complete(s,p.id);
  assert.doesNotMatch(researchPayload(s,p,s.stage(p.id,'jurisdiction')).messages[0].content,/corrected the project country/);
  await e.resume(p.id,{country:'Canada'});
  let next=s.project(p.id);
  assert.equal(next.input.country,'Canada');assert.equal(next.input.previousCountry,'United States');assert.equal(next.address,input.address);
  assert.ok(s.stages(p.id).every(stage=>stage.status==='queued'&&stage.rounds===0));
  assert.ok(s.events(p.id).some(ev=>ev.message==='Project country changed from United States to Canada. Jurisdiction research and the stages that depend on it were reopened.'));
  assert.equal(s.diagnostics(p.id).find(d=>d.event==='project.resumed').details.countryChanged,true);
  assert.ok(!JSON.stringify(diagnosticReport(s,{projectId:p.id})).includes('100 Test Avenue'));
  assert.match(researchPayload(s,next,s.stage(p.id,'jurisdiction')).messages[0].content,/corrected the project country\. projectInputs\.country is the current country; projectInputs\.previousCountry was entered earlier/);
  assert.match(reviewPayload(s,next).messages[0].content[0].text,/evidence_package\.project\.country is the current country/);
  // The same country, however it is written, is not a change.
  complete(s,p.id);await e.resume(p.id,{country:'CA'});
  assert.ok(s.stages(p.id).filter(stage=>stage.id!=='review').every(stage=>stage.status==='complete'));
  // An address in the other country needs the country with it, and a refusal changes nothing.
  const events=s.events(p.id).length;
  await assert.rejects(e.resume(p.id,{address:'21000 Atlantic Blvd, Ashburn VA 20147'}),/appears to be in the United States/);
  await assert.rejects(e.resume(p.id,{country:'Mexico'}),/Choose United States or Canada/);
  await assert.rejects(e.resume(p.id,{country:'United States',finishPartial:true}),/partial report would describe the previous location/);
  await assert.rejects(e.resume(p.id,{country:'United States',focus:'fire_protection'}),/no simultaneous scope change/);
  assert.equal(s.project(p.id).input.country,'Canada');assert.equal(s.events(p.id).length,events);
  await e.resume(p.id,{address:'21000 Atlantic Blvd, Ashburn VA 20147',country:'United States'});
  next=s.project(p.id);assert.equal(next.input.country,'United States');assert.equal(next.input.previousCountry,'Canada');assert.equal(next.address,'21000 Atlantic Blvd, Ashburn VA 20147');
});

test('a country saved before the US/Canada choice is kept until another is chosen',async t=>{
  const s=setup(t),e=engine(t,s),p=s.create(input);
  s.updateProject(p.id,{input:{...p.input,country:'Mexico'}});complete(s,p.id);
  await e.resume(p.id,{country:'Mexico',clarification:'Permit date confirmed.'});
  assert.equal(s.project(p.id).input.country,'Mexico');assert.equal(s.project(p.id).input.previousCountry,undefined);
  complete(s,p.id);await e.resume(p.id,{country:'United States'});
  assert.equal(s.project(p.id).input.country,'United States');assert.equal(s.project(p.id).input.previousCountry,'Mexico');
  const legacy=s.create(input);s.updateProject(legacy.id,{input:{...legacy.input,country:'USA'}});complete(s,legacy.id);
  await e.resume(legacy.id,{country:'United States'});
  assert.equal(s.project(legacy.id).input.country,'USA');assert.ok(s.stages(legacy.id).filter(stage=>stage.id!=='review').every(stage=>stage.status==='complete'));
});

test('the project endpoint refuses another country and serves the shared location module',async t=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'ahj-atlas-location-http-')),app=await createApp({dataDir:dir,port:0,provider:new FakeProvider(),worker:false});
  t.after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});
  const {token}=await(await fetch(app.url+'/api/bootstrap')).json();
  const create=body=>fetch(app.url+'/api/projects',{method:'POST',headers:{'Content-Type':'application/json','X-App-Token':token},body:JSON.stringify(body)});
  let response=await create({...input,country:'Mexico'});assert.equal(response.status,400);assert.match((await response.json()).error,/Choose United States or Canada/);
  response=await create({...input,address:TORONTO,country:'United States'});assert.equal(response.status,400);assert.match((await response.json()).error,/appears to be in Canada/);
  response=await create({...input,address:TORONTO,country:'Canada'});assert.equal(response.status,201);assert.equal((await response.json()).input.country,'Canada');
  const module=await fetch(app.url+'/location.js');assert.equal(module.status,200);assert.match(module.headers.get('content-type'),/text\/javascript/);assert.match(await module.text(),/export function addressCountry/);
});
