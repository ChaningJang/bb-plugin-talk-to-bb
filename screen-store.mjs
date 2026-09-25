// Created: 2026-09-15. Server-side view of what the browser is actually sharing.
// Snapshots stay in memory for the session. A file is written only when the user
// authorizes handing one to an agent, so this is never a recording of the screen.
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const JPEG_PREFIX='data:image/jpeg;base64,';
export const MAX_SNAPSHOT_BYTES=1_048_576;
export const STALE_MS=5*60_000;
// The POST body budget. Frames travel over the authenticated plugin HTTP route,
// not the voice WebSocket, so this is a deliberate latency choice rather than a
// guess about an undocumented frame limit.
export const MAX_BODY_BYTES=1_500_000;

export function decodeFrame(image){
  if(typeof image!=='string'||!image.startsWith(JPEG_PREFIX))throw new Error('Unsupported snapshot encoding.');
  const bytes=Buffer.from(image.slice(JPEG_PREFIX.length),'base64');
  if(!bytes.length)throw new Error('Empty snapshot.');
  if(bytes.length>MAX_SNAPSHOT_BYTES)throw new Error('Snapshot too large.');
  if(bytes[0]!==0xff||bytes[1]!==0xd8)throw new Error('Snapshot is not a JPEG.');
  return bytes;
}

/** What the browser says it is sharing right now. Nothing here is inferred. */
export class ShareState {
  constructor(){this.active=false;this.surface=null;this.label=null;this.since=null;}
  update(share){
    const active=share?.active===true;
    this.active=active;
    this.surface=active&&typeof share.surface==='string'?share.surface.slice(0,32):null;
    this.label=active&&typeof share.label==='string'?share.label.slice(0,80):null;
    this.since=active&&typeof share.since==='string'?share.since.slice(0,40):null;
    return this.describe();
  }
  clear(){return this.update({active:false});}
  describe(){return {active:this.active,surface:this.surface,label:this.label,since:this.since};}
}

/** A small ring of recent snapshots. Old entries are dropped, not archived. */
export class SnapshotStore {
  constructor({directory,limit=4,now=()=>Date.now(),write=writeFile,ensure=mkdir,inspect=stat}){
    Object.assign(this,{directory,limit,now,write,ensure,inspect});
    this.items=new Map();
  }
  put(frame){
    const bytes=decodeFrame(frame.image);
    const id=`snap_${randomUUID().replaceAll('-','').slice(0,12)}`;
    const record={id,bytes,at:this.now(),capturedAt:frame.capturedAt,surface:frame.surface,label:frame.label,
      width:frame.width,height:frame.height,sourceWidth:frame.sourceWidth,sourceHeight:frame.sourceHeight,
      byteLength:bytes.length,path:null,dataUrl:frame.image};
    this.items.set(id,record);
    while(this.items.size>this.limit)this.items.delete(this.items.keys().next().value);
    return record;
  }
  get(id){return this.items.get(id)||null;}
  age(record){return this.now()-record.at;}
  stale(record,maxMs=STALE_MS){return this.age(record)>maxMs;}
  /** Writes the JPEG so a delegated agent can actually open it. Idempotent per snapshot. */
  async persist(id){
    const record=this.get(id);
    if(!record)throw new Error('That snapshot is no longer held for this session.');
    if(record.path){
      const info=await this.inspect(record.path).catch(()=>null);
      if(info?.size)return record;
      record.path=null;
    }
    await this.ensure(this.directory,{recursive:true,mode:0o700});
    const path=join(this.directory,`${id}.jpg`);
    await this.write(path,record.bytes,{mode:0o600});
    const info=await this.inspect(path);
    if(!info?.size)throw new Error('The snapshot file could not be written.');
    record.path=path;record.fileBytes=info.size;
    return record;
  }
  /** Sharing stopped or the call ended: the frames go, they are not kept around. */
  clear(){for(const record of this.items.values())record.dataUrl='';this.items.clear();}
}

export function describeSnapshot(record,ageMs){
  return {snapshotId:record.id,capturedAt:record.capturedAt,ageSeconds:Math.round(ageMs/1000),
    surface:record.surface,source:record.label,width:record.width,height:record.height,
    originalWidth:record.sourceWidth,originalHeight:record.sourceHeight,bytes:record.byteLength};
}

/**
 * Capture ids issued to one browser, redeemed once over the authenticated HTTP
 * route. An id is server-generated, sent only to the socket that asked for it,
 * single-use, and dies with its session — so a POST cannot smuggle a frame into
 * a session that never requested one.
 */
export class FrameInbox {
  constructor({limitBytes=MAX_BODY_BYTES}={}){this.limitBytes=limitBytes;this.pending=new Map();}
  get size(){return this.pending.size;}
  open(id,{sessionId,resolve,reject}){this.pending.set(id,{sessionId,resolve,reject});}
  close(id){this.pending.delete(id);}
  /** Drops every id belonging to a session that ended or stopped sharing. */
  cancel(sessionId,error){
    for(const [id,entry] of [...this.pending])if(entry.sessionId===sessionId){this.pending.delete(id);entry.reject(error);}
  }
  /** @returns {{status:number,ok:boolean,reason?:string}} the HTTP outcome, with no body echoed back. */
  deliver({id,payload,byteLength}){
    if(byteLength>this.limitBytes)return {status:413,ok:false,reason:'too-large'};
    if(typeof id!=='string'||!id)return {status:400,ok:false,reason:'bad-request'};
    const entry=this.pending.get(id);
    // Unknown, already redeemed, or from a finished session: indistinguishable on purpose.
    if(!entry)return {status:404,ok:false,reason:'unknown-capture'};
    if(!payload||typeof payload!=='object')return {status:400,ok:false,reason:'bad-request'};
    this.pending.delete(id);
    entry.resolve(payload);
    return {status:200,ok:true};
  }
}
