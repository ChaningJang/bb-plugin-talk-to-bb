// Created: 2026-09-15. Opt-in display capture in the user's browser.
// The user picks the surface; nothing leaves the page until they have.
export const SURFACES={browser:'browser tab',window:'window',monitor:'screen'};
// Frames are POSTed to the plugin's authenticated HTTP route, never the voice
// WebSocket. This cap is a latency choice, not a transport limit.
export const MAX_FRAME_BYTES=900_000;
export const SHRINK_STEPS=[{maxEdge:1152,quality:0.62},{maxEdge:896,quality:0.5},{maxEdge:640,quality:0.42}];

/** Draws the live display track into a bounded JPEG. Injected so the controller stays testable. */
export async function renderFrame({stream,maxEdge,quality,document:doc=globalThis.document}){
  const video=doc.createElement('video');
  video.srcObject=stream;video.muted=true;video.playsInline=true;
  await video.play();
  if(video.readyState<2)await new Promise((resolve,reject)=>{
    video.onloadeddata=resolve;video.onerror=()=>reject(new Error('The shared surface produced no frame.'));
  });
  const w=video.videoWidth,h=video.videoHeight;
  if(!w||!h)throw new Error('The shared surface produced no frame.');
  const scale=Math.min(1,maxEdge/Math.max(w,h));
  const canvas=doc.createElement('canvas');
  canvas.width=Math.max(1,Math.round(w*scale));canvas.height=Math.max(1,Math.round(h*scale));
  const ctx=canvas.getContext('2d');
  if(!ctx)throw new Error('This browser cannot read the shared surface.');
  ctx.drawImage(video,0,0,canvas.width,canvas.height);
  const dataUrl=canvas.toDataURL('image/jpeg',quality);
  video.srcObject=null; // detaching the source is what releases the frame

  if(!dataUrl.startsWith('data:image/jpeg;base64,'))throw new Error('This browser cannot encode the shared surface.');
  return {dataUrl,width:canvas.width,height:canvas.height,sourceWidth:w,sourceHeight:h};
}

/**
 * The only thing a user sees when a start fails is this line, so it has to be
 * something they can act on. A declined picker is not an error. A host that
 * never opens one is, and its platform string ("Not supported", from Chromium's
 * MediaStreamRequestResult::NOT_SUPPORTED) tells the user nothing about what to
 * do next. Matched on the name or that exact message because only the message is
 * verified against the shipped binary; the DOMException name is inferred.
 */
export function shareFailureNote(error){
  if(error?.name==='NotAllowedError'||error?.name==='AbortError')
    return 'Screen sharing was not started. Talk to BB still cannot see your screen.';
  if(error?.name==='NotSupportedError'||String(error?.message||'').trim()==='Not supported')
    return 'This BB window cannot open a screen picker, so sharing cannot start here. Open BB in a browser tab and try Share screen again.';
  return error?.message||'Screen sharing could not start.';
}

/**
 * Sharing is a user gesture, never a background capability. `active` is the single
 * source of truth for the indicator, for the capture path, and for what the server
 * is told; no frame is produced while it is false.
 */
export class ScreenShare {
  /** @param {{getDisplayMedia:(constraints:any)=>Promise<any>,render?:(options:any)=>Promise<any>,send:(message:any)=>void,upload?:((payload:any)=>Promise<void>)|null,onChange?:(descriptor:any)=>void,now?:()=>number,maxEdge?:number,quality?:number,minIntervalMs?:number,maxFrames?:number,steps?:{maxEdge:number,quality:number}[]}} options */
  constructor({getDisplayMedia,render=renderFrame,send,upload=null,onChange=()=>{},now=()=>Date.now(),maxEdge=1152,quality=0.62,minIntervalMs=1200,maxFrames=40,steps=SHRINK_STEPS}){
    Object.assign(this,{getDisplayMedia,render,send,upload,onChange,now,maxEdge,quality,minIntervalMs,maxFrames,steps});
    this.stream=null;this.surface=null;this.label=null;this.since=null;
    this.frames=0;this.last=null;this.busy=false;
  }
  get active(){return Boolean(this.stream);}
  descriptor(){return {active:this.active,surface:this.surface,label:this.label,since:this.since,frames:this.frames};}
  announce(){this.send({type:'screen-share',share:{active:this.active,surface:this.surface,label:this.label,since:this.since}});this.onChange(this.descriptor());}
  /** Must be called directly from a click; the browser prompt is the consent step. */
  async start(){
    if(this.active)return this.descriptor();
    const stream=await this.getDisplayMedia({video:{frameRate:{max:5}},audio:false});
    const [track]=stream.getVideoTracks?.()??[];
    if(!track){stream.getTracks?.().forEach(t=>t.stop());throw new Error('That selection did not provide a video surface.');}
    this.stream=stream;
    const settings=track.getSettings?.()??{};
    this.surface=SURFACES[settings.displaySurface]?settings.displaySurface:'unknown';
    this.label=String(track.label||SURFACES[this.surface]||'shared surface').slice(0,80);
    this.since=new Date(this.now()).toISOString();this.frames=0;this.last=null;
    // The browser's own "Stop sharing" must move this state too, or the indicator lies.
    track.addEventListener?.('ended',()=>this.stop('ended'));
    this.announce();
    return this.descriptor();
  }
  stop(reason='user'){
    if(!this.active)return null;
    this.stream.getTracks?.().forEach(t=>t.stop());
    this.stream=null;this.surface=null;this.label=null;this.since=null;this.last=null;
    this.announce();
    return reason;
  }
  /** Answers a server capture request. Always replies, so the tool can never hang. */
  async handle(action){
    if(!action||action.kind!=='capture-screen'||typeof action.id!=='string')return;
    const reply=async value=>{
      const payload={type:'screen-frame',id:action.id,...value};
      if(!this.upload)return this.send(payload);
      // A frame never goes over the voice socket. If the POST fails the socket
      // carries only the bad news, which cannot exceed the control-message budget.
      try{await this.upload(payload);}
      catch{this.send({type:'screen-frame',id:action.id,ok:false,reason:'upload-failed'});}
    };
    if(!this.active)return await reply({ok:false,reason:'not-sharing'});
    if(this.frames>=this.maxFrames)return await reply({ok:false,reason:'frame-limit'});
    if(this.busy)return await reply({ok:false,reason:'capture-in-progress'});
    const at=this.now();
    if(this.last&&at-this.last.at<this.minIntervalMs)
      return await reply({ok:true,reused:true,...this.last.frame});
    this.busy=true;
    try {
      let frame=await this.render({stream:this.stream,maxEdge:this.maxEdge,quality:this.quality});
      // A dense 4K monitor can still encode large; step down rather than drop the look entirely.
      for(const step of this.steps){
        if(frame.dataUrl.length<=MAX_FRAME_BYTES)break;
        frame=await this.render({stream:this.stream,...step});
      }
      if(!this.active)return await reply({ok:false,reason:'not-sharing'});
      if(frame.dataUrl.length>MAX_FRAME_BYTES)return await reply({ok:false,reason:'frame-too-large'});
      const payload={image:frame.dataUrl,width:frame.width,height:frame.height,
        sourceWidth:frame.sourceWidth,sourceHeight:frame.sourceHeight,
        surface:this.surface,label:this.label,capturedAt:new Date(at).toISOString()};
      this.frames++;this.last={at,frame:payload};
      this.onChange(this.descriptor());
      await reply({ok:true,reused:false,...payload});
    } catch(error){
      await reply({ok:false,reason:'capture-failed',message:String(error?.message||'').slice(0,160)});
    } finally { this.busy=false; }
  }
  dispose(){this.stream?.getTracks?.().forEach(t=>t.stop());this.stream=null;this.surface=null;this.label=null;this.since=null;this.last=null;this.frames=0;}
}
