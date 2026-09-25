// @vitest-environment jsdom
// Created: 2026-09-15. Verify microphone and floating-panel lifecycle.
import { afterEach, expect, test, vi } from 'vitest';
import { act, fireEvent, cleanup } from '@testing-library/react';
import { loadPluginApp, renderSlot } from '@get-bb/plugin-sdk/testing/app';

afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.restoreAllMocks();});

test('sidebar control opens panel; denied microphone never opens a voice connection',async()=>{
  const app=await loadPluginApp(()=>import('../app'));
  const socket=vi.fn();vi.stubGlobal('WebSocket',socket);
  Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:vi.fn().mockRejectedValue(new DOMException('Denied','NotAllowedError'))}});
  const slot=renderSlot(app.appOverlays[0],{});
  expect(app.experimentalSidebarFooterItems[0].label).toBe('Talk to BB');
  await act(async()=>window.dispatchEvent(new Event('talk-to-bb:toggle')));
  fireEvent.click(slot.getByRole('button',{name:'Start talking'}));
  await slot.findByText(/Microphone blocked/);
  expect(socket).not.toHaveBeenCalled();
  slot.lifecycle.unmount();
});

test('live panel survives minimization and thread navigation; pause, quiet, and end release the right resources',async()=>{
  const app=await loadPluginApp(()=>import('../app'));
  const track={enabled:true,stop:vi.fn()};
  Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:vi.fn().mockResolvedValue({getTracks:()=>[track],getAudioTracks:()=>[track]})}});
  const audioClose=vi.fn().mockResolvedValue(undefined),workletPost=vi.fn();
  vi.stubGlobal('AudioContext',class {
    sampleRate=16000;audioWorklet={addModule:vi.fn().mockResolvedValue(undefined)};destination={};
    resume=vi.fn().mockResolvedValue(undefined);close=audioClose;createMediaStreamSource=()=>({connect:vi.fn()});
  });
  vi.stubGlobal('AudioWorkletNode',class {port={postMessage:workletPost,onmessage:null};connect=vi.fn();disconnect=vi.fn();});
  let ws:any;
  vi.stubGlobal('WebSocket',class {
    readyState=1;bufferedAmount=0;send=vi.fn();close=vi.fn();onopen:any;onmessage:any;onclose:any;onerror:any;
    constructor(){ws=this;}
  });
  const slot=renderSlot(app.appOverlays[0],{},{context:{threadId:'thr_a',projectId:'proj_a'}});
  await act(async()=>window.dispatchEvent(new Event('talk-to-bb:toggle')));
  await act(async()=>fireEvent.click(slot.getByRole('button',{name:'Start talking'})));
  await act(async()=>{ws.onopen();ws.onmessage({data:JSON.stringify({type:'ready'})});});
  expect(JSON.parse(ws.send.mock.calls[0][0]).context.threadId).toBe('thr_a');
  await act(async()=>ws.onmessage({data:JSON.stringify({type:'ui-action',kind:'focus-thread',id:'focus1',threadId:'thr_a'})}));
  expect(ws.send.mock.calls.map((c:any)=>JSON.parse(c[0]))).toContainEqual({type:'ui-result',id:'focus1',threadId:'thr_a',ok:true});
  await act(async()=>ws.onmessage({data:JSON.stringify({type:'action',receipt:{id:'act1',kind:'bb_spawn_thread',status:'started',title:'Delegated task',threadId:'thr_worker',model:'claude-opus-5[1m]'}})}));
  expect(slot.getByText('Delegated task')).toBeTruthy();
  fireEvent.click(slot.getByRole('button',{name:'Pause mic'}));expect(track.enabled).toBe(false);
  fireEvent.click(slot.getByRole('button',{name:'Resume mic'}));expect(track.enabled).toBe(true);
  fireEvent.click(slot.getByRole('button',{name:'Quiet'}));expect(workletPost).toHaveBeenCalledWith({type:'flush'});
  fireEvent.click(slot.getByRole('button',{name:'Minimize Talk to BB'}));
  expect(slot.queryByRole('dialog')).toBeNull();expect(track.stop).not.toHaveBeenCalled();
  fireEvent.click(slot.getByRole('button',{name:/Talk to BB · live/}));
  await act(async()=>ws.onmessage({data:JSON.stringify({type:'lookup',state:'done',sources:[{id:'thr_b',title:'Another project thread',read:true}]})}));
  fireEvent.click(slot.getByText('Another project thread'));
  expect(slot.inspection.navigateCalls).toContainEqual({method:'toThread',threadId:'thr_b'});
  expect(track.stop).not.toHaveBeenCalled();
  fireEvent.click(slot.getByRole('button',{name:'End'}));
  expect(track.stop).toHaveBeenCalledOnce();expect(audioClose).toHaveBeenCalledOnce();expect(ws.close).toHaveBeenCalledOnce();
  expect(slot.getByText('Microphone off')).toBeTruthy();
  slot.lifecycle.unmount();
});

// Created: 2026-09-15. Shared screen context: the indicator must never outrun the capture.
const SHARED_FRAME='data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2Q==';

function stubDisplayRendering(){
  vi.spyOn(HTMLMediaElement.prototype,'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype,'readyState','get').mockReturnValue(4);
  vi.spyOn(HTMLVideoElement.prototype,'videoWidth','get').mockReturnValue(2560);
  vi.spyOn(HTMLVideoElement.prototype,'videoHeight','get').mockReturnValue(1440);
  vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue({drawImage:vi.fn()} as any);
  vi.spyOn(HTMLCanvasElement.prototype,'toDataURL').mockReturnValue(SHARED_FRAME);
}

async function liveSession(getDisplayMedia:any){
  const app=await loadPluginApp(()=>import('../app'));
  const posted:any[]=[];
  vi.stubGlobal('fetch',vi.fn(async(url:any,init:any)=>{
    posted.push({url:String(url),method:init.method,contentType:init.headers['Content-Type'],
      credentials:init.credentials,body:JSON.parse(init.body)});
    return {ok:true,status:200};
  }));
  const micTrack={enabled:true,stop:vi.fn()};
  Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{
    getUserMedia:vi.fn().mockResolvedValue({getTracks:()=>[micTrack],getAudioTracks:()=>[micTrack]}),getDisplayMedia,
  }});
  vi.stubGlobal('AudioContext',class {
    sampleRate=16000;audioWorklet={addModule:vi.fn().mockResolvedValue(undefined)};destination={};
    resume=vi.fn().mockResolvedValue(undefined);close=vi.fn().mockResolvedValue(undefined);createMediaStreamSource=()=>({connect:vi.fn()});
  });
  vi.stubGlobal('AudioWorkletNode',class {port={postMessage:vi.fn(),onmessage:null};connect=vi.fn();disconnect=vi.fn();});
  let ws:any;
  vi.stubGlobal('WebSocket',class {
    readyState=1;bufferedAmount=0;send=vi.fn();close=vi.fn();onopen:any;onmessage:any;onclose:any;onerror:any;
    constructor(){ws=this;}
  });
  const slot=renderSlot(app.appOverlays[0],{},{context:{threadId:'thr_a',projectId:'proj_a'}});
  await act(async()=>window.dispatchEvent(new Event('talk-to-bb:toggle')));
  await act(async()=>fireEvent.click(slot.getByRole('button',{name:'Start talking'})));
  await act(async()=>{ws.onopen();ws.onmessage({data:JSON.stringify({type:'ready'})});});
  const sentOfType=(type:string)=>ws.send.mock.calls.map((c:any)=>JSON.parse(c[0])).filter((m:any)=>m.type===type);
  return {slot,ws,sentOfType,posted};
}

test('screen sharing is opt-in, visibly indicated, and released on Stop sharing and End',async()=>{
  stubDisplayRendering();
  const displayTrack={label:'Chrome — Proposal draft',getSettings:()=>({displaySurface:'browser'}),
    stop:vi.fn(),addEventListener:vi.fn()};
  const displayStream={getVideoTracks:()=>[displayTrack],getTracks:()=>[displayTrack]};
  const getDisplayMedia=vi.fn().mockResolvedValue(displayStream);
  const {slot,ws,sentOfType,posted}=await liveSession(getDisplayMedia);

  // Before any selection the panel says plainly that BB cannot see the screen.
  expect(slot.getByText(/BB cannot see your screen/)).toBeTruthy();
  await act(async()=>ws.onmessage({data:JSON.stringify({type:'ui-action',kind:'capture-screen',id:'cap0',reason:'read the error'})}));
  expect(posted.at(-1)).toMatchObject({url:'/api/v1/plugins/talk-to-bb/http/frame',method:'POST',
    contentType:'application/json',credentials:'same-origin',
    body:{type:'screen-frame',id:'cap0',ok:false,reason:'not-sharing'}});
  expect(sentOfType('screen-frame')).toEqual([]);
  expect(getDisplayMedia).not.toHaveBeenCalled();

  await act(async()=>fireEvent.click(slot.getByRole('button',{name:'Share screen'})));
  expect(getDisplayMedia).toHaveBeenCalledOnce();
  expect(slot.getByText(/Sharing your browser tab — Chrome — Proposal draft/)).toBeTruthy();
  expect(slot.getByText(/has taken none yet/)).toBeTruthy();
  expect(sentOfType('screen-share')[0].share).toMatchObject({active:true,surface:'browser',label:'Chrome — Proposal draft'});

  await act(async()=>ws.onmessage({data:JSON.stringify({type:'ui-action',kind:'capture-screen',id:'cap1',reason:'read the error'})}));
  const frame=posted.at(-1).body;
  expect(frame).toMatchObject({id:'cap1',ok:true,image:SHARED_FRAME,surface:'browser',width:1152});
  expect(typeof frame.capturedAt).toBe('string');
  // The image must never appear on the voice socket.
  expect(JSON.stringify(ws.send.mock.calls)).not.toContain('data:image/');
  expect(sentOfType('screen-frame')).toEqual([]);
  expect(slot.getByText(/1 so far/)).toBeTruthy();

  await act(async()=>fireEvent.click(slot.getByRole('button',{name:'Stop sharing'})));
  expect(displayTrack.stop).toHaveBeenCalledOnce();
  expect(slot.queryByText(/Sharing your browser tab/)).toBeNull();
  expect(slot.getByText(/BB cannot see your screen/)).toBeTruthy();
  expect(sentOfType('screen-share').at(-1).share.active).toBe(false);
  await act(async()=>ws.onmessage({data:JSON.stringify({type:'ui-action',kind:'capture-screen',id:'cap2',reason:'again'})}));
  expect(posted.at(-1).body).toEqual({type:'screen-frame',id:'cap2',ok:false,reason:'not-sharing'});

  // Sharing again then ending the call must release the display track with the microphone.
  await act(async()=>fireEvent.click(slot.getByRole('button',{name:'Share screen'})));
  fireEvent.click(slot.getByRole('button',{name:'End'}));
  expect(displayTrack.stop).toHaveBeenCalledTimes(2);
  expect(slot.queryByRole('button',{name:'Stop sharing'})).toBeNull();
  slot.lifecycle.unmount();
});

test('a cancelled screen picker leaves the panel saying BB still cannot see the screen',async()=>{
  stubDisplayRendering();
  const getDisplayMedia=vi.fn().mockRejectedValue(new DOMException('Denied','NotAllowedError'));
  const {slot,ws,sentOfType,posted}=await liveSession(getDisplayMedia);
  await act(async()=>fireEvent.click(slot.getByRole('button',{name:'Share screen'})));
  expect(slot.getByText(/Screen sharing was not started/)).toBeTruthy();
  expect(slot.queryByText(/Sharing your/)).toBeNull();
  expect(slot.queryByRole('button',{name:'Stop sharing'})).toBeNull();
  expect(sentOfType('screen-share')).toEqual([]);
  await act(async()=>ws.onmessage({data:JSON.stringify({type:'ui-action',kind:'capture-screen',id:'cap1',reason:'look'})}));
  expect(posted.at(-1).body).toEqual({type:'screen-frame',id:'cap1',ok:false,reason:'not-sharing'});
  expect(sentOfType('screen-frame')).toEqual([]);
  slot.lifecycle.unmount();
});

test('a host that cannot open a picker says so instead of printing the platform string',async()=>{
  stubDisplayRendering();
  // What the BB desktop app actually does: the API is present, and Chromium rejects
  // because the Electron shell registers no display-media request handler.
  const getDisplayMedia=vi.fn().mockRejectedValue(new DOMException('Not supported','NotSupportedError'));
  const {slot,ws,sentOfType,posted}=await liveSession(getDisplayMedia);
  await act(async()=>fireEvent.click(slot.getByRole('button',{name:'Share screen'})));
  expect(getDisplayMedia).toHaveBeenCalled();
  // The bare platform string is what the user reported; it must never reach them.
  expect(slot.queryByText('Not supported')).toBeNull();
  expect(slot.getByText(/cannot open a screen picker/)).toBeTruthy();
  expect(slot.getByText(/browser tab/)).toBeTruthy();
  // A refused start is still not sharing: no indicator, no capture, no state drift.
  expect(slot.queryByText(/Sharing your/)).toBeNull();
  expect(slot.queryByRole('button',{name:'Stop sharing'})).toBeNull();
  expect(sentOfType('screen-share')).toEqual([]);
  await act(async()=>ws.onmessage({data:JSON.stringify({type:'ui-action',kind:'capture-screen',id:'cap1',reason:'look'})}));
  expect(posted.at(-1).body).toEqual({type:'screen-frame',id:'cap1',ok:false,reason:'not-sharing'});
  expect(sentOfType('screen-frame')).toEqual([]);
  slot.lifecycle.unmount();
});

test('the review toggle is a third, separate control; notes render and held updates release on request',async()=>{
  const app=await loadPluginApp(()=>import('../app'));
  const track={enabled:true,stop:vi.fn()};
  Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:vi.fn().mockResolvedValue({getTracks:()=>[track],getAudioTracks:()=>[track]})}});
  vi.stubGlobal('AudioContext',class {
    sampleRate=16000;audioWorklet={addModule:vi.fn().mockResolvedValue(undefined)};destination={};
    resume=vi.fn().mockResolvedValue(undefined);close=vi.fn().mockResolvedValue(undefined);createMediaStreamSource=()=>({connect:vi.fn()});
  });
  vi.stubGlobal('AudioWorkletNode',class {port={postMessage:vi.fn(),onmessage:null};connect=vi.fn();disconnect=vi.fn();});
  let ws:any;
  vi.stubGlobal('WebSocket',class {
    readyState=1;bufferedAmount=0;send=vi.fn();close=vi.fn();onopen:any;onmessage:any;onclose:any;onerror:any;
    constructor(){ws=this;}
  });
  const sent=()=>ws.send.mock.calls.map((c:any)=>JSON.parse(c[0]));
  const slot=renderSlot(app.appOverlays[0],{},{context:{threadId:'thr_proposal',projectId:'proj_a'}});
  await act(async()=>window.dispatchEvent(new Event('talk-to-bb:toggle')));
  await act(async()=>fireEvent.click(slot.getByRole('button',{name:'Start talking'})));
  await act(async()=>{ws.onopen();ws.onmessage({data:JSON.stringify({type:'ready'})});});

  // Pause mic, Quiet and Review are three distinct controls.
  expect(slot.getByRole('button',{name:'Pause mic'})).toBeTruthy();
  expect(slot.getByRole('button',{name:'Quiet'})).toBeTruthy();
  await act(async()=>fireEvent.click(slot.getByRole('button',{name:'Review'})));
  expect(sent()).toContainEqual({type:'review',on:true});
  expect(sent().some((m:any)=>m.type==='mute')).toBe(false);

  await act(async()=>ws.onmessage({data:JSON.stringify({type:'review',state:{active:true,topic:'the proposal',held:2,noteCount:2,awaiting:[],
    notes:[{seq:1,kind:'comment',text:'The intro spends too long on methodology',anchor:null,adopted:['Cut it to two lines']},
           {seq:2,kind:'decision',text:'We are not naming the pilot work',anchor:null,adopted:[]}]}})}));
  expect(slot.getByText(/Review mode · the proposal/)).toBeTruthy();
  expect(slot.getByText('1. The intro spends too long on methodology')).toBeTruthy();
  expect(slot.getByText('adopted instead: Cut it to two lines')).toBeTruthy();
  expect(slot.getByText(/2 agent updates held/)).toBeTruthy();
  expect(slot.getByText(/Review on/)).toBeTruthy();

  await act(async()=>fireEvent.click(slot.getByRole('button',{name:'Show updates'})));
  expect(sent()).toContainEqual({type:'review-drain'});

  // Muting audio while reviewing must not end the review.
  await act(async()=>fireEvent.click(slot.getByRole('button',{name:'Quiet'})));
  expect(slot.getByRole('button',{name:'End review'})).toBeTruthy();
  await act(async()=>fireEvent.click(slot.getByRole('button',{name:'End review'})));
  expect(sent()).toContainEqual({type:'review',on:false});
  expect(track.stop).not.toHaveBeenCalled();
  slot.lifecycle.unmount();
});

test('the panel warns before the cap and shows what carried over without replaying it',async()=>{
  const app=await loadPluginApp(()=>import('../app'));
  const track={enabled:true,stop:vi.fn()};
  Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:vi.fn().mockResolvedValue({getTracks:()=>[track],getAudioTracks:()=>[track]})}});
  vi.stubGlobal('AudioContext',class {
    sampleRate=16000;audioWorklet={addModule:vi.fn().mockResolvedValue(undefined)};destination={};
    resume=vi.fn().mockResolvedValue(undefined);close=vi.fn().mockResolvedValue(undefined);createMediaStreamSource=()=>({connect:vi.fn()});
  });
  vi.stubGlobal('AudioWorkletNode',class {port={postMessage:vi.fn(),onmessage:null};connect=vi.fn();disconnect=vi.fn();});
  let ws:any;
  vi.stubGlobal('WebSocket',class {
    readyState=1;bufferedAmount=0;send=vi.fn();close=vi.fn();onopen:any;onmessage:any;onclose:any;onerror:any;
    constructor(){ws=this;}
  });
  const slot=renderSlot(app.appOverlays[0],{},{context:{threadId:'thr_a',projectId:'proj_a'}});
  await act(async()=>window.dispatchEvent(new Event('talk-to-bb:toggle')));
  await act(async()=>fireEvent.click(slot.getByRole('button',{name:'Start talking'})));
  await act(async()=>{ws.onopen();ws.onmessage({data:JSON.stringify({type:'ready'})});});
  await act(async()=>ws.onmessage({data:JSON.stringify({type:'resume',summary:{endedAt:'2026-09-16T04:04:00.000Z',reason:'time-limit',
    unfinished:'actually make that seven thirty and',commitments:['Send Sam the budget number'],
    unresolved:[{title:'Move the Thursday block',status:'uncertain',threadId:null}],
    note:'Nothing was resumed automatically. Restate anything you still want done.'}})}));
  expect(slot.getByText(/seven thirty/)).toBeTruthy();
  expect(slot.getByText(/Send Sam the budget number/)).toBeTruthy();
  expect(slot.getByText(/Move the Thursday block \(uncertain\)/)).toBeTruthy();
  expect(slot.getByText(/Nothing was resumed automatically/)).toBeTruthy();
  const beforeNotice=ws.send.mock.calls.length;
  await act(async()=>ws.onmessage({data:JSON.stringify({type:'notice',kind:'time-remaining',text:'About 5 minutes left in this voice session.'})}));
  expect(slot.getByText(/About 5 minutes left/)).toBeTruthy();
  expect(slot.getByText(/Nothing continues on its own/)).toBeTruthy();
  expect(ws.send.mock.calls.length).toBe(beforeNotice);
  await act(async()=>ws.onmessage({data:JSON.stringify({type:'closed',seconds:1200,reason:'time-limit'})}));
  expect(slot.getByText(/Twenty-minute limit reached \(1200 seconds\)/)).toBeTruthy();
  expect(slot.queryByText(/About 5 minutes left/)).toBeNull();
  expect(track.stop).toHaveBeenCalledOnce();
  slot.lifecycle.unmount();
});

test('a review restored from the previous session is visible in the panel, not implied',async()=>{
  const app=await loadPluginApp(()=>import('../app'));
  const track={enabled:true,stop:vi.fn()};
  Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:vi.fn().mockResolvedValue({getTracks:()=>[track],getAudioTracks:()=>[track]})}});
  vi.stubGlobal('AudioContext',class {
    sampleRate=16000;audioWorklet={addModule:vi.fn().mockResolvedValue(undefined)};destination={};
    resume=vi.fn().mockResolvedValue(undefined);close=vi.fn().mockResolvedValue(undefined);createMediaStreamSource=()=>({connect:vi.fn()});
  });
  vi.stubGlobal('AudioWorkletNode',class {port={postMessage:vi.fn(),onmessage:null};connect=vi.fn();disconnect=vi.fn();});
  let ws:any;
  vi.stubGlobal('WebSocket',class {
    readyState=1;bufferedAmount=0;send=vi.fn();close=vi.fn();onopen:any;onmessage:any;onclose:any;onerror:any;
    constructor(){ws=this;}
  });
  const slot=renderSlot(app.appOverlays[0],{},{context:{threadId:'thr_a',projectId:'proj_a'}});
  await act(async()=>window.dispatchEvent(new Event('talk-to-bb:toggle')));
  await act(async()=>fireEvent.click(slot.getByRole('button',{name:'Start talking'})));
  await act(async()=>{ws.onopen();ws.onmessage({data:JSON.stringify({type:'ready'})});});
  // The server restores the mode and says so; the panel must show both, not one.
  await act(async()=>ws.onmessage({data:JSON.stringify({type:'review',state:{active:true,topic:'the Acme proposal',
    notes:[{seq:1,kind:'correction',text:'The pricing table is too dense',anchor:null,adopted:[]}],noteCount:1,held:2,awaiting:[]}})}));
  await act(async()=>ws.onmessage({data:JSON.stringify({type:'resume',summary:{endedAt:'2026-09-16T04:04:00.000Z',reason:'time-limit',
    unfinished:null,commitments:[],unresolved:[],openReview:{topic:'the Acme proposal',noteCount:1,restored:true},
    note:'Nothing was resumed automatically. Restate anything you still want done.'}})}));
  expect(slot.getByText(/Review mode · the Acme proposal/)).toBeTruthy();
  expect(slot.getByText(/Review reopened:/)).toBeTruthy();
  expect(slot.getByText(/agent actions are blocked again until you end it/)).toBeTruthy();
  expect(slot.getByText(/1\. The pricing table is too dense/)).toBeTruthy();
  expect(slot.getByText(/2 agent updates held/)).toBeTruthy();
  expect(slot.getByRole('button',{name:'End review'})).toBeTruthy();
  slot.lifecycle.unmount();
});
