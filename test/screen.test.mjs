// Created: 2026-09-15. Shared screen context: consent, capture, image delivery, teardown.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScreenShare, shareFailureNote } from '../screen-share.mjs';
import { ShareState, SnapshotStore, decodeFrame } from '../screen-store.mjs';
import { createManager, UserRequests, profiles, screenNote, attachmentRecord, IMAGE_CLAIM } from '../bb-manager.mjs';
import { TalkSession, screenLine, config } from '../live-session.mjs';

// A real (tiny) JPEG so nothing in the path is fooled by a placeholder string.
const JPEG=Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==','base64');
const DATA_URL=`data:image/jpeg;base64,${JPEG.toString('base64')}`;

function browser({frames=[DATA_URL],now=()=>1_000_000}={}){
  const sent=[],rendered=[],stopped=[];const listeners=new Map();
  const track={label:'Chrome — BB Threads',getSettings:()=>({displaySurface:'browser'}),
    stop(){stopped.push('video');},addEventListener:(type,fn)=>listeners.set(type,fn)};
  const stream={getVideoTracks:()=>[track],getTracks:()=>[track]};
  let index=0;
  const share=new ScreenShare({
    getDisplayMedia:async()=>stream,
    render:async(options)=>{rendered.push(options);const dataUrl=frames[Math.min(index++,frames.length-1)];
      return {dataUrl,width:1152,height:648,sourceWidth:2560,sourceHeight:1440};},
    send:value=>sent.push(value),now,
  });
  return {share,sent,rendered,stopped,listeners,track};
}

test('no snapshot exists before the user has chosen a surface',async()=>{
  const b=browser();
  await b.share.handle({kind:'capture-screen',id:'c1',reason:'read the error'});
  assert.deepEqual(b.sent,[{type:'screen-frame',id:'c1',ok:false,reason:'not-sharing'}]);
  assert.equal(b.rendered.length,0);
  assert.equal(b.share.active,false);
  assert.equal(screenLine(b.share.descriptor()).startsWith('The user is NOT sharing'),true);
});

test('an accepted selection produces one bounded frame with its own source metadata',async()=>{
  const b=browser();
  const descriptor=await b.share.start();
  assert.deepEqual(descriptor,{active:true,surface:'browser',label:'Chrome — BB Threads',since:'1970-01-01T00:16:40.000Z',frames:0});
  assert.deepEqual(b.sent[0],{type:'screen-share',share:{active:true,surface:'browser',label:'Chrome — BB Threads',since:'1970-01-01T00:16:40.000Z'}});
  await b.share.handle({kind:'capture-screen',id:'c1',reason:'read the error'});
  const frame=b.sent.at(-1);
  assert.equal(frame.type,'screen-frame');assert.equal(frame.ok,true);assert.equal(frame.reused,false);
  assert.equal(frame.image,DATA_URL);assert.equal(frame.surface,'browser');
  assert.equal(frame.capturedAt,'1970-01-01T00:16:40.000Z');
  assert.equal(frame.sourceWidth,2560);
  assert.equal(b.share.descriptor().frames,1);
});

test('an oversized encode is stepped down rather than dropped, and refused if it stays too large',async()=>{
  const huge=`data:image/jpeg;base64,${'A'.repeat(1_000_000)}`;
  const shrunk=browser({frames:[huge,huge,DATA_URL]});
  await shrunk.share.start();
  await shrunk.share.handle({kind:'capture-screen',id:'c1',reason:'look'});
  assert.equal(shrunk.sent.at(-1).ok,true);
  assert.deepEqual(shrunk.rendered.slice(1).map(o=>o.maxEdge),[1152,896]);
  const never=browser({frames:[huge]});
  await never.share.start();
  await never.share.handle({kind:'capture-screen',id:'c2',reason:'look'});
  assert.deepEqual(never.sent.at(-1),{type:'screen-frame',id:'c2',ok:false,reason:'frame-too-large'});
});

test('stopping sharing releases the track, announces it, and blocks further capture',async()=>{
  const b=browser();await b.share.start();
  await b.share.handle({kind:'capture-screen',id:'c1',reason:'look'});
  const before=b.rendered.length;
  b.share.stop('user');
  assert.deepEqual(b.stopped,['video']);
  assert.deepEqual(b.sent.at(-1),{type:'screen-share',share:{active:false,surface:null,label:null,since:null}});
  await b.share.handle({kind:'capture-screen',id:'c2',reason:'look again'});
  assert.deepEqual(b.sent.at(-1),{type:'screen-frame',id:'c2',ok:false,reason:'not-sharing'});
  assert.equal(b.rendered.length,before,'no frame may be rendered after sharing stops');
});

test('the browser’s own Stop sharing moves the indicator, and dispose releases capture',async()=>{
  const b=browser();await b.share.start();
  b.listeners.get('ended')();
  assert.equal(b.share.active,false);
  assert.equal(b.sent.at(-1).share.active,false);
  const c=browser();await c.share.start();c.share.dispose();
  assert.equal(c.share.active,false);assert.deepEqual(c.stopped,['video']);
});

test('a rapid re-look reuses the last frame and keeps its true capture time', async()=>{
  let clock=1_000_000;const b=browser({now:()=>clock});
  await b.share.start();
  await b.share.handle({kind:'capture-screen',id:'c1',reason:'look'});
  clock+=300;
  await b.share.handle({kind:'capture-screen',id:'c2',reason:'again'});
  const second=b.sent.at(-1);
  assert.equal(second.reused,true);
  assert.equal(second.capturedAt,'1970-01-01T00:16:40.000Z','a reused frame must not claim to be fresh');
  assert.equal(b.rendered.length,1);
  clock+=5000;
  await b.share.handle({kind:'capture-screen',id:'c3',reason:'again'});
  assert.equal(b.sent.at(-1).reused,false);
  assert.equal(b.rendered.length,2);
});

test('the snapshot store rejects anything that is not a bounded JPEG',()=>{
  assert.throws(()=>decodeFrame('data:image/png;base64,iVBORw0KGgo='),/Unsupported snapshot encoding/);
  assert.throws(()=>decodeFrame(`data:image/jpeg;base64,${Buffer.from('not a jpeg').toString('base64')}`),/not a JPEG/);
  assert.throws(()=>decodeFrame(`data:image/jpeg;base64,${'A'.repeat(3_000_000)}`),/too large/);
  const state=new ShareState();
  assert.deepEqual(state.update({active:true,surface:'monitor',label:'Display 1',since:'t'}),{active:true,surface:'monitor',label:'Display 1',since:'t'});
  assert.deepEqual(state.clear(),{active:false,surface:null,label:null,since:null});
});

test('a snapshot file is written only on demand, is reused, and is dropped when sharing ends',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'ttbb-snap-'));
  try {
    const store=new SnapshotStore({directory});
    const record=store.put({image:DATA_URL,capturedAt:'2026-09-15T12:00:00.000Z',surface:'browser',label:'BB',width:1152,height:648,sourceWidth:2560,sourceHeight:1440});
    assert.equal(record.path,null,'nothing is written just because a look happened');
    const saved=await store.persist(record.id);
    assert.deepEqual(await readFile(saved.path),JPEG);
    assert.equal((await store.persist(record.id)).path,saved.path);
    store.clear();
    await assert.rejects(store.persist(record.id),/no longer held/);
  } finally { await rm(directory,{recursive:true,force:true}); }
});

// --- manager: authorization, image delivery, and honest attachment reporting ---

function managerFixture({hostId='host_a',projectId='proj_a',snapshot=null,captureError=null,failDispatch=false,uploadError=null}={}){
  const uploads=[];
  const map=new Map(),calls=[],receipts=[],requests=new UserRequests();
  const store={get:async k=>map.get(k),set:async(k,v)=>{map.set(k,structuredClone(v));},list:async()=>[...map.keys()]};
  const cli=async args=>{
    calls.push(args);
    if(args[0]==='environment')return {id:'env_a',projectId:'proj_a',status:'ready',hostId,isGitRepo:true,defaultBranch:'main'};
    if(args[0]==='provider')return [{id:profiles.general.model}];
    if(args[1]==='show')return {thread:{id:args[2],title:'Source thread',status:'idle',projectId,environmentHostId:hostId}};
    if(args[1]==='spawn'){if(failDispatch)throw new Error('timeout');return {thread:{id:'thr_new'},delivery:'sent'};}
    if(args[1]==='tell')return {delivery:'sent'};
    return {};
  };
  const screen={
    capture:async({reason})=>{
      if(captureError)throw captureError;
      return {snapshot:{snapshotId:'snap_abc123',capturedAt:'2026-09-15T12:00:00.000Z',ageSeconds:2,surface:'browser',
        source:'BB Threads',width:1152,height:648,bytes:12_000,reason},share:{active:true,surface:'browser',label:'BB Threads',since:'t'}};
    },
    attach:async(id,targetProjectId)=>{
      if(!snapshot)throw new Error('unexpected attach');
      assert.equal(id,snapshot.snapshotId);
      if(uploadError)throw uploadError;
      uploads.push({id,projectId:targetProjectId});
      return {...snapshot,projectId:targetProjectId};
    },
  };
  return {map,calls,receipts,requests,screen,uploads,
    make:()=>createManager({cli,store,requests,sessionId:'session_1',originThreadId:null,focus:async()=>{},screen,onReceipt:r=>receipts.push(r)})};
}
// What screen.attach returns after uploading: an opaque BB attachment path, not a machine path.
const savedSnapshot={snapshotId:'snap_abc123',path:'snap_abc123-1789525660531-v56l7v.jpg',bytes:12_000,
  capturedAt:'2026-09-15T12:00:00.000Z',surface:'browser',label:'BB Threads'};
const spawnArgs={projectId:'proj_a',environmentId:'env_a',parentThreadId:null,title:'Fix the layout bug on screen',
  brief:'Reproduce and fix the overlap the user pointed at. Make no other changes.',profile:'general',isolatedWorktree:false};

test('looking at the screen needs a live request and records a receipt naming the surface',async()=>{
  const f=managerFixture();
  await assert.rejects(f.make()('bb_view_screen',{reason:'read the error',request:'What does my screen say'}),/not in this live conversation/);
  f.requests.append('What does my screen say',0,true);
  const result=await f.make()('bb_view_screen',{reason:'read the error',request:'What does my screen say'});
  assert.equal(result.screen.snapshotId,'snap_abc123');
  assert.equal(result.screen.imageProvided,true);
  assert.equal(result.screen.surfaceLabel,'browser tab');
  assert.equal(result.receipt.status,'captured');
  assert.match(result.receipt.title,/Looked at the shared browser tab/);
  assert.equal(f.receipts.length,1);
});

test('a refused capture surfaces the reason and leaves no receipt claiming a look happened',async()=>{
  const error=Object.assign(new Error('The user is not sharing a screen right now.'),{name:'ActionError'});
  const f=managerFixture({captureError:error});
  f.requests.append('Look at my screen',0,true);
  await assert.rejects(f.make()('bb_view_screen',{reason:'look',request:'Look at my screen'}),/not sharing a screen/);
  assert.equal(f.receipts.length,0);
});

test('attaching a snapshot puts the real image on the agent’s message and says so once',async()=>{
  const f=managerFixture({snapshot:savedSnapshot});
  const request='Have an agent fix what I am pointing at on screen';
  f.requests.append(request,0,true);
  const result=await f.make()('bb_spawn_thread',{...spawnArgs,attachSnapshotId:'snap_abc123',request});
  const cmd=f.calls.find(c=>c[1]==='spawn');
  assert.equal(cmd[cmd.indexOf('--image')+1],savedSnapshot.path);
  const prompt=cmd[cmd.indexOf('--prompt')+1];
  assert.match(prompt,/attached to this message as an image you can open directly/);
  assert.match(prompt,/2026-09-15T12:00:00.000Z/);
  assert.match(prompt,/one still frame, not a live view/);
  assert.doesNotMatch(prompt,/\/srv\/|\/Users\/|\/home\//,'the brief must not name a machine-local path');
  assert.deepEqual(f.uploads,[{id:'snap_abc123',projectId:'proj_a'}],'upload is bound to the target project');
  assert.deepEqual(result.receipt.attachedImage,{snapshotId:'snap_abc123',capturedAt:savedSnapshot.capturedAt,surface:'browser',bytes:12_000,path:savedSnapshot.path});
  assert.match(result.attachment.note,/it can actually see it/);
});

test('an agent on a different machine than the BB server still receives the image',async()=>{
  // host_mac runs the BB server; the worker environment is on another machine entirely.
  const f=managerFixture({hostId:'host_server',snapshot:savedSnapshot});
  const request='Send that screen to an agent';
  f.requests.append(request,0,true);
  const result=await f.make()('bb_spawn_thread',{...spawnArgs,attachSnapshotId:'snap_abc123',request});
  const cmd=f.calls.find(c=>c[1]==='spawn');
  assert.equal(cmd[cmd.indexOf('--image')+1],savedSnapshot.path);
  assert.equal(result.attachment.delivered,true);
  assert.equal(result.attachment.path,savedSnapshot.path);
  assert.deepEqual(f.uploads,[{id:'snap_abc123',projectId:'proj_a'}]);
});

test('a failed upload refuses the whole dispatch rather than sending a bare reference',async()=>{
  const error=Object.assign(new Error('The snapshot upload did not return a usable attachment.'),{name:'ActionError'});
  const f=managerFixture({snapshot:savedSnapshot,uploadError:error});
  const request='Send that screen to an agent';
  f.requests.append(request,0,true);
  await assert.rejects(f.make()('bb_spawn_thread',{...spawnArgs,attachSnapshotId:'snap_abc123',request}),/upload did not return a usable attachment/);
  assert.equal(f.calls.filter(c=>c[1]==='spawn').length,0);
  assert.equal(f.receipts.length,0,'no receipt may exist for work that was never dispatched');
});

test('a follow-up uploads into the project that owns the target thread',async()=>{
  const f=managerFixture({projectId:'proj_other',snapshot:savedSnapshot});
  const request='Show that agent what I am looking at';
  f.requests.append(request,0,true);
  await f.make()('bb_tell_thread',{threadId:'thr_a',mode:'steer',message:'See the attached screen.',attachSnapshotId:'snap_abc123',request});
  assert.deepEqual(f.uploads,[{id:'snap_abc123',projectId:'proj_other'}]);
});

test('an unattached delegation never mentions a screenshot',async()=>{
  const f=managerFixture();
  const request='Start an agent on the layout bug';
  f.requests.append(request,0,true);
  const result=await f.make()('bb_spawn_thread',{...spawnArgs,request});
  const cmd=f.calls.find(c=>c[1]==='spawn');
  assert.equal(cmd.includes('--image'),false);
  assert.doesNotMatch(cmd[cmd.indexOf('--prompt')+1],/snapshot/i);
  assert.equal(result.receipt.attachedImage,null);
  // The contract with capability discovery: false, never absent.
  assert.deepEqual(result.attachment,{requested:null,saved:false,delivered:false,path:null,snapshotId:null,
    capturedAt:null,surface:null,source:null,bytes:null,
    note:'No screen snapshot was attached. If a capability declares an image input, say that input is missing rather than naming a file.'});
  assert.equal(screenNote(null),'');
});

test('a follow-up can carry the snapshot to an existing agent on the same machine',async()=>{
  const f=managerFixture({snapshot:savedSnapshot});
  const request='Show that agent what I am looking at';
  f.requests.append(request,0,true);
  const result=await f.make()('bb_tell_thread',{threadId:'thr_a',mode:'steer',
    message:'The overlap is in the header, as shown.',attachSnapshotId:'snap_abc123',request});
  const cmd=f.calls.find(c=>c[1]==='tell');
  assert.equal(cmd[cmd.indexOf('--image')+1],savedSnapshot.path);
  assert.match(cmd[3],/attached to this message as an image/);
  assert.equal(result.attachment.delivered,true);
});

// --- transport: the image reaches the backend as an image item, in order ---

test('a chosen capture reaches the backend as an image input item before the tool result',async()=>{
  const sent=[];
  const session=new TalkSession({key:'test',query:async(name)=>{
    assert.equal(name,'bb_view_screen');
    // What the server does inside the tool call: queue the image, then return the receipt.
    session.provideImage({dataUrl:DATA_URL,text:'Screen snapshot the user is sharing with you.'});
    return {screen:{snapshotId:'snap_abc123',imageProvided:true}};
  }});
  session.socket={readyState:1,bufferedAmount:0,send:v=>sent.push(JSON.parse(v)),close(){},terminate(){}};
  session.ready=true;
  const envelope=event=>({type:'response.event',delegation_id:'del_1',event});
  session.handle(envelope({type:'response.created',response:{id:'r_1'}}));
  session.handle(envelope({type:'response.output_item.done',item:{type:'function_call',call_id:'a',name:'bb_view_screen',arguments:'{}'}}));
  session.handle(envelope({type:'response.completed',response:{id:'r_1'}}));
  await new Promise(resolve=>setImmediate(resolve));
  const types=sent.map(e=>e.type);
  assert.deepEqual(types,['response.item.create','response.item.create','response.create']);
  const image=sent[0].item;
  assert.equal(image.type,'message');assert.equal(image.role,'user');
  assert.deepEqual(image.content[0],{type:'input_image',image_url:DATA_URL,detail:'high'});
  assert.equal(image.content[1].type,'input_text');
  assert.equal(sent[1].item.type,'function_call_output');
  assert.equal(sent[1].item.call_id,'a');
  session.clear();
});

test('no image is queued once the session is closing, and junk payloads are refused',()=>{
  const sent=[];
  const session=new TalkSession({key:'test',query:async()=>({})});
  session.socket={readyState:1,bufferedAmount:0,send:v=>sent.push(JSON.parse(v)),close(){},terminate(){}};
  session.ready=true;
  assert.equal(session.provideImage({dataUrl:'https://example.com/shot.png',text:'x'}),false);
  assert.equal(session.provideImage({dataUrl:`data:image/jpeg;base64,${'A'.repeat(2_100_000)}`,text:'x'}),false);
  assert.equal(sent.length,0);
  assert.equal(session.provideImage({dataUrl:DATA_URL,text:'x'}),true);
  session.closing=true;
  assert.equal(session.provideImage({dataUrl:DATA_URL,text:'x'}),false);
  assert.equal(sent.filter(e=>e.type==='response.item.create').length,1);
  session.clear();
});

test('instructions never claim screen access unless the browser is sharing',()=>{
  const off=config({threadId:null,projectId:null});
  assert.match(off.instructions,/You cannot see anything on their screen/);
  assert.match(off.delegation.responses.instructions,/NOT sharing a screen/);
  const on=config({threadId:null,projectId:null},{share:{active:true,surface:'monitor',label:'Display 1',since:'t'}});
  assert.match(on.instructions,/IS sharing a whole screen/);
  assert.match(on.delegation.responses.instructions,/attachment.delivered/);
  const session=new TalkSession({key:'test',query:async()=>({})});
  const sent=[];
  session.socket={readyState:1,bufferedAmount:0,send:v=>sent.push(JSON.parse(v)),close(){},terminate(){}};
  session.ready=true;
  session.updateScreenShare({active:true,surface:'window',label:'Figma',since:'t'});
  assert.match(sent[0].session.delegation.responses.instructions,/IS sharing a window/);
  assert.equal(sent[1].type,'session.instructions.append');
  assert.equal(sent[1].delegation_id,null);
  session.updateScreenShare({active:false});
  assert.match(sent.at(-1).content,/NOT sharing a screen/);
  session.clear();
});

test('an unconfirmed dispatch drops the attachment claim instead of keeping it',async()=>{
  const f=managerFixture({snapshot:savedSnapshot,failDispatch:true});
  const request='Send that screen to an agent';
  f.requests.append(request,0,true);
  const result=await f.make()('bb_spawn_thread',{...spawnArgs,attachSnapshotId:'snap_abc123',request});
  assert.equal(result.receipt.status,'uncertain');
  assert.equal(result.receipt.attachedImage,null);
  assert.equal(result.attachment.delivered,false);
  assert.equal(result.attachment.saved,true,'the file was written even though the agent never got it');
  assert.match(result.attachment.note,/did not reach the agent/);
  assert.match(result.attachment.note,/Do not tell the user the agent can see the screen/);
});

test('a brief that names a snapshot without attaching one is refused',async()=>{
  const f=managerFixture({snapshot:savedSnapshot});
  const request='Have an agent diagnose that screen';
  f.requests.append(request,0,true);
  const manage=f.make();
  await assert.rejects(manage('bb_spawn_thread',{...spawnArgs,
    brief:'Diagnose the screen. The screenshot is at /srv/.bb/talk-to-bb/snapshots/snap_abc123.jpg.',request}),/names a screen snapshot without attaching one/);
  await assert.rejects(manage('bb_tell_thread',{threadId:'thr_a',mode:'steer',
    message:'Use snapshot snap_abc123 for the diagnosis.',request}),/names a screen snapshot without attaching one/);
  assert.equal(f.calls.filter(c=>c[1]==='spawn'||c[1]==='tell').length,0);
  assert.equal(f.receipts.length,0);
  // Ordinary briefs are unaffected.
  const ok=await manage('bb_spawn_thread',{...spawnArgs,brief:'Fix the snapshot testing helper in test/utils.js.',request});
  assert.equal(ok.receipt.status,'started');
});

test('the attachment record is the same shape whether or not anything was attached',()=>{
  const empty=attachmentRecord();
  const full=attachmentRecord({requested:'snap_abc123',attachment:savedSnapshot,saved:true,delivered:true});
  assert.deepEqual(Object.keys(empty),Object.keys(full));
  assert.equal(empty.saved,false);assert.equal(empty.delivered,false);
  assert.match(empty.note,/say that input is missing rather than naming a file/);
  const savedOnly=attachmentRecord({requested:'snap_abc123',attachment:savedSnapshot,saved:true,delivered:false});
  assert.equal(savedOnly.path,savedSnapshot.path);
  assert.match(savedOnly.note,/did not reach the agent/);
});

test('a brief that presumes an attached image without one is refused',async()=>{
  const f=managerFixture({snapshot:savedSnapshot});
  const request='Have an agent diagnose that screen';
  f.requests.append(request,0,true);
  const manage=f.make();
  // The likelier failure than naming a file: the capability declares an image input,
  // the brief is written around it, and nothing was attached.
  await assert.rejects(manage('bb_spawn_thread',{...spawnArgs,
    brief:'Diagnose the key behaviour for this screen. The screenshot is attached.',request}),/tells the agent an image is attached, but none is/);
  await assert.rejects(manage('bb_tell_thread',{threadId:'thr_a',mode:'steer',
    message:'As shown in the attached, the header overlaps the nav.',request}),/tells the agent an image is attached, but none is/);
  assert.equal(f.calls.filter(c=>c[1]==='spawn'||c[1]==='tell').length,0);
  assert.equal(f.receipts.length,0);
  // The refusal names the honest alternative rather than just blocking.
  await manage('bb_spawn_thread',{...spawnArgs,
    brief:'Diagnose the key behaviour for this screen. The image input is MISSING; work from this description: a checkout step with an overlapping header.',request})
    .then(r=>assert.equal(r.receipt.status,'started'));
});

test('the guard refuses presumed images without blocking instructions to make one',()=>{
  for(const claim of ['See the attached screenshot and fix the overlap.','The screenshot is attached; diagnose the key behaviour.',
    'Attached image shows the checkout step.','As shown in the attached, the header overlaps.',
    'The overlap is visible in the screenshot above.','Use the provided screenshot for the diagnosis.'])
    assert.equal(IMAGE_CLAIM.test(claim),true,`should refuse: ${claim}`);
  for(const fine of ['Take a screenshot of the page and compare it to the mock.',
    'Capture a screenshot after the fix and attach it to your report.',
    'Fix the snapshot testing helper in test/utils.js.','Screenshot the failing state before you change anything.',
    'Compare screenshots across the two branches.','Add an image upload field to the form.',
    'The image pipeline drops alpha channels; fix it.'])
    assert.equal(IMAGE_CLAIM.test(fine),false,`should allow: ${fine}`);
});

test('an attached delegation may describe the image freely',async()=>{
  const f=managerFixture({snapshot:savedSnapshot});
  const request='Send that screen to an agent';
  f.requests.append(request,0,true);
  // With a real attachment the same wording is true, so it must pass.
  const result=await f.make()('bb_spawn_thread',{...spawnArgs,attachSnapshotId:'snap_abc123',
    brief:'Diagnose the key behaviour. The screenshot is attached; work from it.',request});
  assert.equal(result.attachment.delivered,true);
});

// A rejected start is the only thing the user sees, so the wording is the feature.
test('a start refusal is explained in terms the user can act on',()=>{
  // The user declining the picker is not an error, and must not read like one.
  for(const name of ['NotAllowedError','AbortError'])
    assert.match(shareFailureNote(new DOMException('Permission denied',name)),
      /^Screen sharing was not started\./);

  // What the BB desktop app produces: Chromium's MediaStreamRequestResult::NOT_SUPPORTED.
  // Matched on either signal because only the message text is verified against the
  // shipped Chromium binary; the DOMException name is not.
  for(const error of [new DOMException('Not supported','NotSupportedError'),
                      new DOMException('Not supported','SomeOtherError'),
                      {name:'NotSupportedError',message:''}]){
    const note=shareFailureNote(error);
    assert.match(note,/cannot open a screen picker/);
    assert.match(note,/browser tab/);
    // The raw platform string is exactly what the user could not act on.
    assert.equal(note.trim()==='Not supported',false);
  }

  // Anything genuinely unexpected keeps its own detail rather than being flattened.
  assert.equal(shareFailureNote(new DOMException('The display surface went away','InvalidStateError')),
    'The display surface went away');
  assert.equal(shareFailureNote(undefined),'Screen sharing could not start.');
});
