import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../lib/store.mjs';
import { researchPayload, reviewPayload } from '../lib/prompts.mjs';
import { chatPayload } from '../lib/chat.mjs';
import { countryNote } from '../lib/country-note.mjs';
import { input } from './fixtures.mjs';

const TORONTO='1 King St W, Toronto, ON M5H 1A1';
function setup(t){const dir=mkdtempSync(path.join(os.tmpdir(),'ahj-atlas-country-note-')),store=new Store(dir);t.after(()=>{store.close();assert.ok(path.resolve(dir).startsWith(path.join(os.tmpdir(),'ahj-atlas-country-note-')));rmSync(dir,{recursive:true,force:true});});return store;}
const texts=(s,p)=>{
  const turn=s.createChatTurn(p.id,{clientId:randomUUID(),message:'Which authority applies?'});
  return {
    research:['jurisdiction','contacts','codes','verification'].map(id=>researchPayload(s,p,s.stage(p.id,id)).messages[0].content),
    review:reviewPayload(s,p).messages[0].content[0].text,
    chat:chatPayload(s,turn).messages.at(-1).content.map(b=>b.text).join('\n'),
  };
};

test('a Canadian project adds the Canadian frameworks note to research, the final review and chat',async t=>{
  const s=setup(t),p=s.create({...input,address:TORONTO,country:'Canada'}),{research,review,chat}=texts(s,p);
  for(const content of research){
    assert.match(content,/Canadian project \(projectInputs\.country is Canada\)\. Research these Canadian frameworks/);
    assert.match(content,/Codes are adopted by the province or territory/);assert.match(content,/Table 1\.3\.1\.2/);assert.match(content,/French-language sources/);
    assert.match(content,/CAN\/ULC-S524/);
  }
  assert.match(review,/Canadian project \(evidence_package\.project\.country is Canada\)\. Report findings within these Canadian frameworks/);
  // In chat the note comes before the user's message, inside the uncached latest turn.
  assert.ok(chat.indexOf('This project is in Canada.')>=0&&chat.indexOf('This project is in Canada.')<chat.indexOf('Latest user message:'));
});

test('the fire protection checks are added only for a fire protection project',()=>{
  const canada={...input,country:'Canada'};
  assert.match(countryNote(canada),/CAN\/ULC-S524/);
  assert.doesNotMatch(countryNote({...canada,discipline:'Architecture'}),/CAN\/ULC-S524|NFPA 72/);
  assert.match(countryNote({...canada,discipline:'Architecture'}),/Canadian Electrical Code, Part I \(CSA C22\.1\)/);
});

test('a US project, or one saved with another country, gets no note',async t=>{
  for(const country of ['United States','USA','Mexico',''])assert.equal(countryNote({...input,country}),'',country);
  const s=setup(t),{research,review,chat}=texts(s,s.create(input));
  for(const text of [...research,review,chat])assert.doesNotMatch(text,/Canadian project|This project is in Canada|Canadian frameworks/);
});
