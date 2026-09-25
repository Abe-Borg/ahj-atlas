import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.mjs';
import { FakeProvider,fakeTools,input,report,evidenceText,nfpaReport,nfpaEvidenceText } from './fixtures.mjs';
import { validateReport } from '../lib/prompts.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const app=await createApp({dataDir:path.join(root,'test-results','ui-workspace'),port:4319,provider:new FakeProvider()});app.services.engine.tools=fakeTools(app.store);app.services.engine.pollMs=10;
if(!app.store.list().length){const p=app.store.create({...input,name:'Example district · synthetic report'});app.store.source(p.id,{url:'https://example.com/adoption',title:'Synthetic adoption record — not project guidance',text:evidenceText,readFull:true});for(const s of app.store.stages(p.id))app.store.updateStage(p.id,s.id,{status:'complete',output:'Synthetic test findings.'});app.store.updateProject(p.id,{status:'complete',report:validateReport(report(),app.store.sources(p.id))});}
for(const p of app.store.list().filter(p=>p.discipline==='Fire protection'&&p.report&&!p.report.fireProtection)){app.store.source(p.id,{url:'https://example.com/adoption',title:'Synthetic adoption — not project guidance',text:nfpaEvidenceText,readFull:true});app.store.updateProject(p.id,{status:'partial',report:validateReport(nfpaReport(),app.store.sources(p.id),[],[],p.input)});}
console.log('Synthetic UI test workspace: '+app.url+' (no paid API calls)');
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>app.close().finally(()=>process.exit()));
