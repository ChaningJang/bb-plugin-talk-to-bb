// Created: 2026-09-15. Screen frames travel over the authenticated HTTP route,
// never the voice WebSocket. These are deterministic in-process transport checks;
// they exercise the real byte path without installing or reloading the plugin.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ScreenShare } from '../screen-share.mjs';
import { FrameInbox, MAX_BODY_BYTES, decodeFrame } from '../screen-store.mjs';

const JPEG=Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==','base64');
const DATA_URL=`data:image/jpeg;base64,${JPEG.toString('base64')}`;
// A frame at the size the shrink steps actually aim for, so the path is exercised at scale.
const BIG_DATA_URL=`data:image/jpeg;base64,${Buffer.concat([JPEG,Buffer.alloc(600_000,0x20)]).toString('base64')}`;

const route=inbox=>async payload=>{
  // Stands in for the plugin HTTP handler: serialize, measure, deliver, map to a status.
  const raw=JSON.stringify(payload);
  const result=inbox.deliver({id:payload?.id,payload:JSON.parse(raw),byteLength:raw.length});
  if(!result.ok)throw Object.assign(new Error(`frame upload ${result.status}`),{status:result.status,reason:result.reason});
  return result;
};

test('a capture id is single-use, session-scoped, and unguessable to redeem',()=>{
  const inbox=new FrameInbox();
  let got=null,failed=null;
  inbox.open('cap-1',{sessionId:'s1',resolve:v=>{got=v;},reject:e=>{failed=e;}});
  assert.deepEqual(inbox.deliver({id:'cap-unknown',payload:{ok:true},byteLength:10}),{status:404,ok:false,reason:'unknown-capture'});
  assert.equal(got,null);
  assert.deepEqual(inbox.deliver({id:'cap-1',payload:{ok:true,image:DATA_URL},byteLength:120}),{status:200,ok:true});
  assert.equal(got.image,DATA_URL);
  // Replay of a redeemed id is indistinguishable from an unknown one.
  assert.deepEqual(inbox.deliver({id:'cap-1',payload:{ok:true},byteLength:10}),{status:404,ok:false,reason:'unknown-capture'});
  assert.equal(inbox.size,0);
  assert.equal(failed,null);
});

test('the route bounds the body and rejects malformed redemptions before touching state',()=>{
  const inbox=new FrameInbox();
  let got=null;
  inbox.open('cap-1',{sessionId:'s1',resolve:v=>{got=v;},reject:()=>{}});
  assert.deepEqual(inbox.deliver({id:'cap-1',payload:{ok:true},byteLength:MAX_BODY_BYTES+1}),{status:413,ok:false,reason:'too-large'});
  assert.deepEqual(inbox.deliver({id:null,payload:{ok:true},byteLength:10}),{status:400,ok:false,reason:'bad-request'});
  assert.deepEqual(inbox.deliver({id:'cap-1',payload:null,byteLength:10}),{status:400,ok:false,reason:'bad-request'});
  assert.equal(got,null,'a rejected redemption must not resolve the pending capture');
  assert.equal(inbox.size,1,'and must not consume the id');
});

test('ending a session cancels its outstanding capture ids',()=>{
  const inbox=new FrameInbox();
  const errors=[];
  inbox.open('cap-a',{sessionId:'s1',resolve:()=>{},reject:e=>errors.push(e)});
  inbox.open('cap-b',{sessionId:'s2',resolve:()=>{},reject:e=>errors.push(e)});
  inbox.cancel('s1',new Error('disconnected'));
  assert.equal(errors.length,1);
  assert.deepEqual(inbox.deliver({id:'cap-a',payload:{ok:true},byteLength:10}),{status:404,ok:false,reason:'unknown-capture'});
  assert.deepEqual(inbox.deliver({id:'cap-b',payload:{ok:true},byteLength:10}),{status:200,ok:true});
});

function browser({frames=[DATA_URL],upload}={}){
  const sent=[],uploaded=[];
  const track={label:'Chrome — BB',getSettings:()=>({displaySurface:'browser'}),stop(){},addEventListener(){}};
  const stream={getVideoTracks:()=>[track],getTracks:()=>[track]};
  let index=0;
  const share=new ScreenShare({
    getDisplayMedia:async()=>stream,
    render:async()=>({dataUrl:frames[Math.min(index++,frames.length-1)],width:1152,height:648,sourceWidth:2560,sourceHeight:1440}),
    send:v=>sent.push(v),now:()=>1_000_000,
    upload:async(payload)=>{uploaded.push(payload);return upload?upload(payload):undefined;},
  });
  return {share,sent,uploaded};
}

test('a frame is POSTed and never put on the voice socket',async()=>{
  const inbox=new FrameInbox();
  let delivered=null;
  inbox.open('cap-1',{sessionId:'s1',resolve:v=>{delivered=v;},reject:()=>{}});
  const b=browser({upload:route(inbox)});
  await b.share.start();
  await b.share.handle({kind:'capture-screen',id:'cap-1',reason:'read the error'});
  assert.equal(b.uploaded.length,1);
  assert.equal(b.uploaded[0].image,DATA_URL);
  // The socket carried the share announcement only — no frame, no image bytes.
  assert.deepEqual(b.sent.map(m=>m.type),['screen-share']);
  assert.equal(JSON.stringify(b.sent).includes('data:image/'),false);
  assert.equal(delivered.image,DATA_URL);
  assert.equal(delivered.capturedAt,'1970-01-01T00:16:40.000Z');
});

test('a realistically large frame survives the round trip and decodes server-side',async()=>{
  const inbox=new FrameInbox();
  let delivered=null;
  inbox.open('cap-1',{sessionId:'s1',resolve:v=>{delivered=v;},reject:()=>{}});
  const b=browser({frames:[BIG_DATA_URL],upload:route(inbox)});
  await b.share.start();
  await b.share.handle({kind:'capture-screen',id:'cap-1',reason:'look'});
  assert.equal(b.sent.filter(m=>m.type==='screen-frame').length,0);
  assert.equal(delivered.image.length,BIG_DATA_URL.length);
  assert.equal(delivered.image,BIG_DATA_URL);
  const bytes=decodeFrame(delivered.image);
  assert.equal(bytes.length,JPEG.length+600_000);
  assert.ok(JSON.stringify(delivered).length>700_000,'the exercised body is well past the old socket assumption');
  assert.ok(JSON.stringify(delivered).length<MAX_BODY_BYTES,'and still inside the declared body budget');
});

test('an upload failure reports bad news on the socket and never leaks the image there',async()=>{
  const inbox=new FrameInbox();
  const b=browser({upload:route(inbox)}); // no id opened, so the route 404s
  await b.share.start();
  await b.share.handle({kind:'capture-screen',id:'cap-missing',reason:'look'});
  const fallback=b.sent.at(-1);
  assert.deepEqual(fallback,{type:'screen-frame',id:'cap-missing',ok:false,reason:'upload-failed'});
  assert.equal(JSON.stringify(b.sent).includes('data:image/'),false);
  assert.ok(JSON.stringify(fallback).length<16000,'the fallback must fit the control-message budget');
});

test('a refusal is also POSTed, and carries no image',async()=>{
  const inbox=new FrameInbox();
  let delivered=null;
  inbox.open('cap-1',{sessionId:'s1',resolve:v=>{delivered=v;},reject:()=>{}});
  const b=browser({upload:route(inbox)});
  await b.share.handle({kind:'capture-screen',id:'cap-1',reason:'look'}); // never started sharing
  assert.deepEqual(delivered,{type:'screen-frame',id:'cap-1',ok:false,reason:'not-sharing'});
  assert.equal(b.sent.length,0);
});
