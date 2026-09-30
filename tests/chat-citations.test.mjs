import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../lib/store.mjs';
import { ResearchTools } from '../lib/research-tools.mjs';
import { initialChatEvidence,citedLookup,chatAnswer } from '../lib/chat-citations.mjs';
import { input } from './fixtures.mjs';
import { CHAT_LIMITS } from '../lib/config.mjs';

function fixture(t){
  const dir=mkdtempSync(path.join(os.tmpdir(),'ahj-citations-')),s=new Store(dir),p=s.create(input),q=s.create({...input,name:'Other project'});
  t.after(()=>{s.close();assert.ok(path.resolve(dir).startsWith(path.join(os.tmpdir(),'ahj-citations-')));rmSync(dir,{recursive:true,force:true});});
  s.source(p.id,{url:'https://example.com/source',title:'Saved source',text:'The exact source passage establishes this synthetic finding.',readFull:true});
  s.source(p.id,{url:'https://example.com/discovery',title:'Search snippet only',text:'Discovery must not be cited as retrieved text.',readFull:false});
  s.source(q.id,{url:'https://example.com/other',title:'Other project source',text:'PRIVATE OTHER PROJECT EVIDENCE',readFull:true});
  return {s,p,q};
}
const citation=block=>({type:'search_result_location',source:block.source,title:'Untrusted provider title',search_result_index:0,start_block_index:0,end_block_index:1,cited_text:block.content[0].text});

test('native chat evidence covers every retrieved source within its bound and excludes discovery-only and foreign records',t=>{
  const {s,p}=fixture(t),first=initialChatEvidence(s,p.id);assert.equal(first.length,1);assert.ok(!first[0].cache_control);assert.equal(first[0].citations.enabled,true);
  assert.ok(!JSON.stringify(first).includes('PRIVATE OTHER'));assert.ok(!JSON.stringify(first).includes('Discovery must'));
  assert.deepEqual(initialChatEvidence(s,p.id),first);
  for(let i=0;i<12;i++)s.source(p.id,{url:'https://example.com/long'+i,text:'Long saved source sentence. '.repeat(1000),readFull:true});
  const results=initialChatEvidence(s,p.id),total=results.flatMap(r=>r.content).reduce((n,b)=>n+b.text.length,0);
  assert.equal(results.length,13);assert.ok(total<=CHAT_LIMITS.excerptChars);assert.deepEqual(results[0].content,first[0].content);
  const small=initialChatEvidence(s,p.id,{characters:6500});assert.ok(small.flatMap(r=>r.content).reduce((n,b)=>n+b.text.length,0)<=6500);
});

test('citation mapping validates the supplied source, block range and quote without trusting URLs or titles',t=>{
  const {s,p,q}=fixture(t),evidence=initialChatEvidence(s,p.id),foreign=initialChatEvidence(s,q.id)[0],c=citation(evidence[0]);
  const payload={messages:[{role:'user',content:evidence}]};
  const invalid=[{...c,source:foreign.source},{...c,source:'javascript:alert(1)'},{...c,cited_text:'Invented quotation'},{...c,start_block_index:-1},{...c,end_block_index:2},{...c,end_block_index:0},{...c,start_block_index:.5},{...c,search_result_index:1},{...c,search_result_index:-1},{...c,type:'web_search_result_location'}];
  const response={content:[{type:'text',text:'The finding ',citations:[c,...invalid]},{type:'text',text:'has a source.'}]},copy=structuredClone(response);
  const answer=chatAnswer(s,p.id,response,payload);assert.equal(answer.answer,'The finding has a source.');assert.deepEqual(answer.answer_parts[0].citations,[{sourceId:'S1',title:'Saved source',quote:c.cited_text}]);assert.deepEqual(response,copy);
  assert.ok(!JSON.stringify(answer).includes('Untrusted provider'));assert.equal(chatAnswer(s,q.id,response,payload).answer_parts[0].citations.length,0);
  assert.equal(chatAnswer(s,p.id,response,{messages:[]}).answer_parts[0].citations.length,0);
});

test('saved lookups return citable original spans with paging metadata kept outside them',async t=>{
  const {s,p}=fixture(t),tools=new ResearchTools(s),raw=(await tools.saved(p.id,{sourceId:'S1'})).text;
  const {content,metadata}=citedLookup(s,p.id,'read_saved_source',raw);assert.ok(content.every(b=>b.type==='search_result'));assert.ok(!Object.hasOwn(metadata,'text'));assert.equal(metadata.sourceId,'S1');
  const response={content:[{type:'text',text:'Supported claim.',citations:[citation(content[0])]}]},payload={messages:[{role:'user',content:[{type:'tool_result',tool_use_id:'saved',content}]}]};
  assert.equal(chatAnswer(s,p.id,response,payload).answer_parts[0].citations[0].sourceId,'S1');
  const noMatch=(await tools.saved(p.id,{sourceId:'S1',query:'missing phrase'})).text;assert.equal(citedLookup(s,p.id,'read_saved_source',noMatch),noMatch);
  const discovery=(await tools.saved(p.id,{sourceId:'S2'})).text;assert.equal(citedLookup(s,p.id,'read_saved_source',discovery),discovery);
});

test('a page read in chat becomes citable under its saved source ID with paging metadata kept outside it',t=>{
  const {s,p}=fixture(t),page=s.source(p.id,{url:'https://county.example.gov/code',title:'County code',text:'Section 1. The county adopts the fire code.',readFull:true});
  const raw=JSON.stringify({sourceId:page.id,retrieved:page.retrieved,url:page.url,title:'County code',note:'',offset:0,totalCharacters:43,truncated:false,nextOffset:null,text:'Section 1. The county adopts the fire code.',links:[{title:'Amendments',url:'https://county.example.gov/amend'}]});
  for(const name of ['read_source','render_page']){
    const {content,metadata}=citedLookup(s,p.id,name,raw);assert.equal(content[0].type,'search_result');assert.match(content[0].title,new RegExp('^'+page.id+': '));assert.ok(!Object.hasOwn(metadata,'text'));assert.equal(metadata.links.length,1);
    const payload={messages:[{role:'user',content:[{type:'tool_result',tool_use_id:'read',content}]}]};
    assert.equal(chatAnswer(s,p.id,{content:[{type:'text',text:'Adopted.',citations:[citation(content[0])]}]},payload).answer_parts[0].citations[0].sourceId,page.id);
  }
  // Failed or discovery-only reads stay plain text.
  const discovery=JSON.stringify({sourceId:'S2',text:'Discovery must not be cited as retrieved text.'});assert.equal(citedLookup(s,p.id,'read_source',discovery),discovery);
  assert.equal(citedLookup(s,p.id,'read_source','not json'),'not json');assert.equal(citedLookup(s,p.id,'inspect_pdf',raw),raw);
});

test('web search citations become leads only for URLs returned by a search in the same reply',t=>{
  const {s,p}=fixture(t),found='https://county.example.gov/fire';
  const lead=(url,extra={})=>({type:'web_search_result_location',url,title:'County fire',encrypted_index:'x',cited_text:'Snippet about the fire code',...extra});
  const searched={role:'assistant',content:[{type:'server_tool_use',id:'srv',name:'web_search',input:{query:'fire'}},{type:'web_search_tool_result',tool_use_id:'srv',content:[{type:'web_search_result',url:found,title:'County fire',encrypted_content:'x'}]}]};
  const response={content:[{type:'text',text:'Claim.',citations:[lead(found),lead('https://other.example.com/'),lead(found,{cited_text:' '}),lead('javascript:alert(1)')]}]};
  const answer=chatAnswer(s,p.id,response,{messages:[{role:'user',content:[]},searched]});
  assert.deepEqual(answer.answer_parts[0].citations,[{kind:'lead',url:found,title:'County fire',quote:'Snippet about the fire code'}]);
  // Results in the current response count too; without any search, nothing is kept.
  assert.equal(chatAnswer(s,p.id,{content:[...searched.content,...response.content]},{messages:[]}).answer_parts[0].citations.length,1);
  assert.equal(chatAnswer(s,p.id,response,{messages:[]}).answer_parts[0].citations.length,0);
});
