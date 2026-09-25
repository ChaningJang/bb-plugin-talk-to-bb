// Created: 2026-09-15. A navigation request succeeds only after BB selects the target.
export class FocusRequests {
  constructor({navigate,currentThread,send,timeoutMs=6000}){Object.assign(this,{navigate,currentThread,send,timeoutMs});this.pending=new Map();}
  open(action){
    if(!action||action.kind!=='focus-thread'||!/^thr_[a-z0-9]+$/.test(action.threadId)||typeof action.id!=='string')return;
    if(this.pending.has(action.id))return;
    const timer=setTimeout(()=>this.finish(action.id,false),this.timeoutMs);
    this.pending.set(action.id,{threadId:action.threadId,timer});
    try{this.navigate(action.threadId);this.observe(this.currentThread());}catch{this.finish(action.id,false);}
  }
  observe(threadId){for(const [id,p] of this.pending)if(p.threadId===threadId)this.finish(id,true);}
  finish(id,ok){const p=this.pending.get(id);if(!p)return;clearTimeout(p.timer);this.pending.delete(id);this.send({type:'ui-result',id,threadId:p.threadId,ok});}
  cancel(){for(const id of this.pending.keys())this.finish(id,false);}
}
