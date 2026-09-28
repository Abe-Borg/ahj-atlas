// Run only against a closed, disposable installed-app profile under test-results.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../lib/store.mjs';
import { KeyVault } from '../lib/key-vault.mjs';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const mode=process.argv[2],profile=path.resolve(process.argv[3]||'');
const testRoot=path.join(root,'test-results');
if(!['seed','verify'].includes(mode)||!path.relative(testRoot,profile)||path.relative(testRoot,profile).startsWith('..'))
  throw new Error('Choose seed or verify and a disposable profile inside test-results.');
const dataDir=path.join(profile,'AHJ Atlas','data');
const vaultDir=path.join(profile,'AHJ Atlas');
assert.ok(existsSync(path.join(dataDir,'atlas.sqlite')),'The installed-app test database is missing.');
assert.ok(!existsSync(path.join(dataDir,'instance.lock')),'Close the installed app before checking its workspace.');
const store=new Store(dataDir);
try{
  const project=store.list().find(p=>p.name==='Electron synthetic report');
  assert.ok(project,'Synthetic report missing from the installed-app profile.');
  if(mode==='seed'){
    const full=store.project(project.id);
    const report=structuredClone(full.report);
    report.gaps.push({question:'Which synthetic office receives the permit?',why:'Upgrade persistence fixture.',contact:'Example Plans Office',nextStep:'Confirm in the synthetic source.'});
    store.updateProject(project.id,{report});
    const question=store.project(project.id).questions.find(q=>q.question.includes('synthetic office'));
    assert.ok(question);
    store.saveQuestion(project.id,{questionId:question.id,status:'answered',answer:'Example Plans Office (synthetic).'});
    store.setSettings({defaultBudget:3,dailyBudget:17});
    store.diagnostic('installer.fixture',{projectId:project.id,phase:'before-upgrade'});
    const vault=new KeyVault({dir:vaultDir});
    vault.set('sk-ant-session4-synthetic-key',true);
    assert.ok(!readFileSync(vault.file).includes(Buffer.from('sk-ant-session4-synthetic-key')),'Credential was not encrypted.');
  }
  const full=store.project(project.id);
  assert.match(full.report.summary,/Synthetic workflow verification/);
  assert.ok(store.sources(project.id).some(s=>s.title==='Synthetic adoption record'));
  assert.ok(store.chatTurns(project.id).some(t=>t.answer?.includes('Synthetic desktop chat reply')));
  assert.ok(full.questions.some(q=>q.question.includes('synthetic office')&&q.status==='answered'&&q.answer.includes('Example Plans Office')));
  assert.equal(store.settings().defaultBudget,3);
  assert.equal(store.settings().dailyBudget,17);
  assert.ok(store.diagnostics().some(d=>d.event==='installer.fixture'));
  const vault=new KeyVault({dir:vaultDir});
  assert.equal(vault.key,'sk-ant-session4-synthetic-key');
  console.log(JSON.stringify({mode,projects:store.list().length,sources:store.sources(project.id).length,chatTurns:store.chatTurns(project.id).length,questions:full.questions.length,diagnostics:store.diagnostics().length,settings:store.settings(),credential:'DPAPI-protected and loadable'},null,2));
}finally{store.close();}
