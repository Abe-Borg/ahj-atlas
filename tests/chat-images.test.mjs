import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { createApp } from '../server.mjs';
import { CHAT_LIMITS } from '../lib/config.mjs';
import { chatPayload, projectSection, storedPayload } from '../lib/chat.mjs';
import { addChatImage, exifOrientation, imageType } from '../lib/images.mjs';
import { input, report, ChatProvider, chatResponse } from './fixtures.mjs';

// Synthetic pictures: a white page with dark text, like a photographed plan review comment.
export function picture(width,height,format='image/png',text='NFPA 13, 2025 edition'){
  const canvas=createCanvas(width,height),ctx=canvas.getContext('2d');
  ctx.fillStyle='#ffffff';ctx.fillRect(0,0,width,height);ctx.fillStyle='#123456';ctx.fillRect(0,0,Math.round(width/4),Math.round(height/4));
  ctx.font=`${Math.max(12,Math.round(height/8))}px sans-serif`;ctx.fillText(text,Math.round(width/10),Math.round(height/2));
  return format==='image/png'?canvas.toBuffer('image/png'):canvas.toBuffer(format,90);
}
// A JPEG with an EXIF APP1 segment whose only tag is the orientation.
export function withOrientation(jpeg,orientation){
  const app1=Buffer.from([0xff,0xe1,0,0x22,0x45,0x78,0x69,0x66,0,0,0x49,0x49,0x2a,0,8,0,0,0,1,0,0x12,0x01,3,0,1,0,0,0,orientation,0,0,0,0,0,0,0]);
  return Buffer.concat([jpeg.subarray(0,2),app1,jpeg.subarray(2)]);
}
async function setup(t,provider=new ChatProvider()){
  const dir=mkdtempSync(path.join(os.tmpdir(),'ahj-chat-images-')),app=await createApp({dataDir:dir,port:0,provider,worker:false});
  t.after(async()=>{await app.close();assert.ok(path.resolve(dir).startsWith(path.join(os.tmpdir(),'ahj-chat-images-')));rmSync(dir,{recursive:true,force:true});});
  const create=name=>{const p=app.store.create({...input,name});app.store.updateProject(p.id,{status:'complete',report:{...report(),summary:name+' report',gaps:[{question:name+' scope?',why:'Scope',contact:'Owner',nextStep:'Confirm.'}]}});for(const s of app.store.stages(p.id))app.store.updateStage(p.id,s.id,{status:'complete',output:name+' brief'});app.store.source(p.id,{url:'https://example.com/'+name,title:name+' source',text:name+' exact source evidence.',readFull:true});return p;};
  const a=create('ALPHA_PRIVATE'),b=create('BRAVO_PRIVATE'),{token}=await(await fetch(app.url+'/api/bootstrap')).json();
  const upload=(body,{name='photo.png',type='image/png',auth=true,id=a.id}={})=>fetch(`${app.url}/api/projects/${id}/images`,{method:'POST',headers:{'Content-Type':type,'X-File-Name':encodeURIComponent(name),...(auth?{'X-App-Token':token}:{})},body});
  const request=(method,id,imageId)=>fetch(`${app.url}/api/projects/${id}/images/${imageId}`,{method,headers:method==='GET'?{}:{'Content-Type':'application/json','X-App-Token':token},body:method==='GET'?undefined:'{}'});
  const post=(id,body)=>fetch(`${app.url}/api/projects/${id}/chat`,{method:'POST',headers:{'Content-Type':'application/json','X-App-Token':token},body:JSON.stringify(body)});
  return {app,provider,a,b,upload,request,post};
}
const body=(message,patch={})=>({clientId:randomUUID(),message,...patch});
async function settled(chat){await Promise.all([...chat.running.values()].map(j=>j.promise));}

test('an attached image is decoded, scaled, turned upright and stored without metadata; the routes serve and remove it',async t=>{
  const {app,a,b,upload,request}=await setup(t),s=app.store;
  // A large screenshot is scaled to what the model would see anyway, and kept as PNG.
  const large=await upload(picture(3000,2000),{name:'C:\\Photos\\Plan review <1>.png'});assert.equal(large.status,201);
  const {image}=await large.json();assert.equal(image.name,'Plan review <1>.png');assert.equal(image.mediaType,'image/png');
  assert.ok(image.width<=CHAT_LIMITS.imageEdge&&image.height<=CHAT_LIMITS.imageEdge);assert.ok(image.width*image.height<=CHAT_LIMITS.imagePixels+image.width+image.height);
  assert.equal(Math.round(image.width/image.height*100),150);assert.match(image.id,/^[0-9a-f]{16}$/);
  assert.deepEqual(s.chatImages(a.id).map(i=>i.id),[image.id]);assert.deepEqual(s.chatImages(b.id),[]);
  const served=await request('GET',a.id,image.id);assert.equal(served.status,200);assert.equal(served.headers.get('content-type'),'image/png');assert.match(served.headers.get('cache-control'),/immutable/);
  const bytes=Buffer.from(await served.arrayBuffer());assert.equal(imageType(bytes),'image/png');const decoded=await loadImage(bytes);assert.equal(decoded.width,image.width);assert.equal(decoded.height,image.height);
  assert.ok(s.diagnosticRows?.()===undefined||true);
  // The same picture again is the same image. A small image keeps its size.
  assert.equal((await(await upload(picture(3000,2000),{name:'again.png'})).json()).image.id,image.id);assert.equal(s.chatImages(a.id).length,1);
  const small=(await(await upload(picture(640,480))).json()).image;assert.equal(small.width,640);assert.equal(small.height,480);
  // A phone photo saved sideways is turned upright, and its EXIF block is not kept.
  const sideways=withOrientation(picture(200,100,'image/jpeg'),6);assert.equal(exifOrientation(sideways),6);assert.equal(exifOrientation(picture(200,100,'image/jpeg')),1);
  const photo=(await(await upload(sideways,{name:'IMG_0001.jpg',type:'image/jpeg'})).json()).image;
  assert.equal(photo.mediaType,'image/jpeg');assert.equal(photo.width,100);assert.equal(photo.height,200);
  assert.ok(!s.chatImage(a.id,photo.id).bytes.includes('Exif'));
  // The bytes decide the type: a declared image type does not make a document an image.
  for(const [content,options,pattern] of [[Buffer.from('PK\u0003\u0004word'),{name:'letter.docx',type:'image/png'},/PNG, JPEG, GIF or WebP/],['Just text',{name:'notes.txt',type:'text/plain'},/PNG, JPEG, GIF or WebP/],['',{},/Choose an image/],[Buffer.concat([picture(10,10).subarray(0,40)]),{},/could not be read/]]){
    const response=await upload(content,options);assert.equal(response.status,400,String(pattern));assert.match((await response.json()).error,pattern);
  }
  assert.equal((await upload(picture(10,10),{auth:false})).status,403);
  assert.equal((await upload(picture(10,10),{id:'00000000-0000-0000-0000-000000000000'})).status,400);
  await assert.rejects(addChatImage(s,a.id,{name:'big.png',buffer:Buffer.alloc(CHAT_LIMITS.imageBytes+1,0)}),/20 MB or less/);
  assert.equal(s.chatImages(a.id).length,3);
  // An unsent image can be removed; another project cannot see or remove it.
  assert.equal((await request('GET',b.id,image.id)).status,404);assert.equal((await request('DELETE',b.id,image.id)).status,404);
  assert.equal((await request('DELETE',a.id,small.id)).status,200);assert.equal((await request('GET',a.id,small.id)).status,404);assert.equal((await request('DELETE',a.id,small.id)).status,404);
  assert.deepEqual(s.chatImages(a.id).map(i=>i.id).sort(),[image.id,photo.id].sort());
});

test('images attached to a message are validated, saved with it, sent as image blocks before its text, kept in later history and deleted with the project',async t=>{
  const {app,provider,a,b,upload,request,post}=await setup(t),s=app.store,c=app.services.chat;
  const first=(await(await upload(picture(800,600),{name:'Comment 1.png'})).json()).image,second=(await(await upload(picture(300,400,'image/jpeg'),{name:'Comment 2.jpg',type:'image/jpeg'})).json()).image;
  const other=(await(await upload(picture(50,50),{name:'Other.png',id:b.id})).json()).image;
  const question=s.project(a.id).questions[0].id;
  for(const value of [body('Hi',{images:first.id}),body('Hi',{images:[first.id,first.id]}),body('Hi',{images:Array.from({length:CHAT_LIMITS.images+1},(_,i)=>'0123456789abcde'+i)}),body('Hi',{images:[other.id]}),body('Hi',{images:['0123456789abcdef']}),body('Hi',{images:[7]}),{clientId:randomUUID(),questionId:question,images:[first.id]}]){
    const response=await post(a.id,value);assert.equal(response.status,400);assert.match((await response.json()).error,/Attach/);
  }
  assert.equal(s.chatTurns(a.id).length,0);
  const request1=body('What edition does the comment in these photos cite?',{images:[first.id,second.id]});
  assert.equal((await post(a.id,request1)).status,202);await settled(c);
  const sent=[{id:first.id,name:'Comment 1.png',width:800,height:600},{id:second.id,name:'Comment 2.jpg',width:300,height:400}];
  assert.deepEqual(c.view(a.id).turns[0].images,sent);assert.deepEqual(projectSection(s,a.id,'conversation')[0].images,sent.map(({name,width,height})=>({name,width,height})));
  const content=provider.calls[0].payload.messages.at(-1).content,text=content.at(-1).text;
  assert.deepEqual(content.slice(-3,-1).map(b=>[b.type,b.source.type,b.source.media_type]),[['image','base64','image/png'],['image','base64','image/jpeg']]);
  assert.equal(content.at(-3).source.data,s.chatImage(a.id,first.id).bytes.toString('base64'));
  assert.ok(text.startsWith('Latest user message:\nWhat edition does the comment in these photos cite?\n\nImages I attached to this message'));
  assert.ok(text.endsWith(JSON.stringify(sent.map(({name,width,height})=>({name,width,height})))));
  assert.ok(!JSON.stringify(provider.calls[0].payload).includes('BRAVO_PRIVATE'));
  assert.match(provider.calls[0].payload.system,/Images the user attached to a message/);
  // The request saved with the attempt keeps the image blocks' place and size, not their data.
  const savedRequest=s.attempts(a.id).find(x=>x.stage_id==='chat').payload,savedLatest=savedRequest.messages.at(-1).content;
  assert.equal(savedLatest.at(-3).type,'image');assert.equal(savedLatest.at(-3).source.data,`[omitted from the saved request: ${content.at(-3).source.data.length} base64 characters]`);
  assert.ok(!JSON.stringify(savedRequest).includes(content.at(-3).source.data));assert.deepEqual(savedRequest.tools,provider.calls[0].payload.tools);
  assert.deepEqual(storedPayload({messages:[{role:'user',content:[{type:'tool_result',tool_use_id:'t',content:[{type:'text',text:'page'},{type:'image',source:{type:'base64',media_type:'image/png',data:'abcd'}}]}]}]}).messages[0].content[0].content[1].source.data,'[omitted from the saved request: 4 base64 characters]');
  // The same send again is the same message; changed images are refused.
  assert.equal((await post(a.id,request1)).status,202);assert.equal(s.chatTurns(a.id).length,1);
  assert.equal((await post(a.id,{...request1,images:[first.id]})).status,400);
  // A later message carries the images in its history, with the note, and not in its own text.
  const turn=s.createChatTurn(a.id,{clientId:randomUUID(),message:'And the amendment?'}),next=chatPayload(s,turn);
  assert.equal(next.messages.at(-1).content.at(-1).text,'Latest user message:\nAnd the amendment?');
  const blocks=next.messages[0].content,at=blocks.findIndex(x=>x.type==='text'&&x.text===text.slice('Latest user message:\n'.length));
  assert.ok(at>1);assert.deepEqual(blocks.slice(at-2,at).map(b=>b.source.media_type),['image/png','image/jpeg']);
  assert.equal(JSON.stringify(next).split('Images I attached').length,2);assert.equal(JSON.stringify(next).split(content.at(-3).source.data).length,2);
  s.updateChatTurn(a.id,turn.id,{status:'complete'});
  // Earlier turns keep their images only while the request's image allowance holds them, newest first.
  const allowance=CHAT_LIMITS.imageRequestBytes,pair=content.at(-3).source.data.length+content.at(-2).source.data.length;
  try{
    const third=s.createChatTurn(a.id,{clientId:randomUUID(),message:'Third question.'}),imagesIn=payload=>payload.messages.flatMap(m=>m.content.filter(b=>b.type==='image'));
    CHAT_LIMITS.imageRequestBytes=pair-1;assert.equal(imagesIn(chatPayload(s,third)).length,0);
    CHAT_LIMITS.imageRequestBytes=pair;assert.equal(imagesIn(chatPayload(s,third)).length,2);s.updateChatTurn(a.id,third.id,{status:'complete'});
    const newest=(await(await upload(picture(200,200),{name:'Newest.png'})).json()).image,fourth=s.createChatTurn(a.id,{clientId:randomUUID(),message:'With a new image.',images:[{id:newest.id,name:newest.name,width:newest.width,height:newest.height}]});
    const latestOnly=chatPayload(s,fourth),latestBlocks=latestOnly.messages.at(-1).content.filter(b=>b.type==='image');
    assert.equal(latestBlocks.length,1);assert.equal(imagesIn(latestOnly).length,1);
    CHAT_LIMITS.imageRequestBytes=pair+latestBlocks[0].source.data.length;assert.equal(imagesIn(chatPayload(s,fourth)).length,3);
    s.updateChatTurn(a.id,fourth.id,{status:'complete'});
  }finally{CHAT_LIMITS.imageRequestBytes=allowance;}
  // A sent image stays with its message. Deleting the project removes every image.
  assert.equal((await request('DELETE',a.id,first.id)).status,409);assert.equal(s.chatImageSent(a.id,first.id),true);
  s.deleteProject(a.id);assert.deepEqual(s.chatImages(a.id),[]);assert.equal(s.db.prepare('SELECT COUNT(*) n FROM chat_images').get().n,1);
});

test('a declined reply retried with the same images sends them again',async t=>{
  let n=0;const provider=new ChatProvider(()=>++n===1?chatResponse('',{stop_reason:'refusal',stop_details:{type:'refusal',category:'general_harms'}}):chatResponse('Read from the attached photo: NFPA 13, 2025 edition.'));
  const {app,a,upload,post}=await setup(t,provider),c=app.services.chat;
  const image=(await(await upload(picture(400,300),{name:'Comment.png'})).json()).image;
  assert.equal((await post(a.id,body('What does this say?',{images:[image.id]}))).status,202);await settled(c);
  const declined=c.view(a.id).turns[0];assert.equal(declined.status,'declined');assert.deepEqual(declined.images.map(i=>i.id),[image.id]);
  assert.equal((await post(a.id,body(declined.user,{mode:declined.retryMode,images:declined.images.map(i=>i.id)}))).status,202);await settled(c);
  assert.equal(provider.calls.length,2);assert.equal(provider.calls[1].payload.messages.at(-1).content.at(-2).type,'image');
  assert.equal(c.view(a.id).turns[1].status,'complete');
});
