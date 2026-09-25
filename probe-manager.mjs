// Created: 2026-09-15. Paid live integration test; creates one hidden, no-work test agent.
import WebSocket from 'ws';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec=promisify(execFile);
const base=process.env.BB_SERVER_URL||'http://127.0.0.1:38886';
const need=(k)=>{const v=process.env[k];if(!v){console.error(`Set ${k} (see the header of this probe).`);process.exit(2);}return v;};
const projectId=need('PROBE_PROJECT_ID');
const environmentId=need('PROBE_ENVIRONMENT_ID');
const parentThreadId=need('PROBE_PARENT_THREAD_ID');
const title=`Talk to BB management probe ${Date.now()}`;
const state=await fetch(`${base}/api/v1/plugins/talk-to-bb/rpc/status`,{method:'POST',headers:{'content-type':'application/json'},body:'null'}).then(r=>r.json());
if(!state.result?.configured||state.result.active)throw new Error('Voice unconfigured or already in use; refusing to interrupt it.');
const ws=new WebSocket(`${base.replace(/^http/,'ws')}/api/v1/plugins/talk-to-bb/http/voice`,{origin:base});
let timer,deadline,followupTimer,workerId,followupSent=false,stopSent=false,fault=null,peak=0;
const receipts=new Map();let transcript='';
const ask=text=>ws.send(JSON.stringify({type:'ask',text}));
const stop=()=>{clearInterval(timer);clearTimeout(deadline);clearTimeout(followupTimer);if(ws.readyState===1)ws.send(JSON.stringify({type:'stop'}));};
deadline=setTimeout(stop,140000);
ws.on('open',()=>ws.send(JSON.stringify({type:'start',context:{threadId:parentThreadId,projectId}})));
ws.on('message',(data,binary)=>{
  if(binary){for(let i=0;i+1<data.length;i+=2)peak=Math.max(peak,Math.abs(data.readInt16LE(i)));return;}
  const e=JSON.parse(data);
  if(e.type==='ready'){
    timer=setInterval(()=>{if(ws.readyState===1)ws.send(Buffer.alloc(640));},20);
    ask(`Test the manager tools. In project ${projectId}, environment ${environmentId}, start exactly one hidden probe agent titled "${title}", using the probe profile, without a worktree. Parent it to ${parentThreadId}. Its entire task is to reply exactly VOICE_MANAGER_PROBE_OK without reading files, using tools, or changing anything. Do not focus the probe. Create no other agent.`);
  }
  if(e.type==='lookup')console.log(JSON.stringify(e));
  if(e.type==='action'){
    const r=e.receipt;
    if(!r)return;
    receipts.set(r.id,r);console.log(JSON.stringify({type:'receipt',...r}));
    if(r.kind==='bb_spawn_thread'&&r.status==='started'){
      workerId=r.threadId;
      if(r.workerState==='replied'&&!followupSent){
        followupSent=true;
        followupTimer=setTimeout(()=>ask(`Send a follow-up to the same test agent ${workerId}: reply exactly VOICE_MANAGER_FOLLOWUP_OK without tools, file reads, or changes. Deliver it now. Do not create another thread.`),2000);
      }
    }
    if(r.kind==='bb_tell_thread'&&['sent','queued'].includes(r.status)&&r.workerState==='replied'&&!stopSent){
      stopSent=true;
      followupTimer=setTimeout(()=>ask(`Stop the test agent ${workerId} now. It is only the management probe.`),2000);
    }
    if(r.kind==='bb_stop_thread'&&r.status==='stopped')followupTimer=setTimeout(stop,5000);
  }
  if(e.type==='transcript'&&e.speaker==='assistant')transcript+=e.text;
  if(e.type==='fault'){fault=e.message;console.error(fault);stop();}
});
ws.on('error',error=>{fault=error.message;console.error(fault);});
ws.on('close',async()=>{
  clearInterval(timer);clearTimeout(deadline);clearTimeout(followupTimer);
  let output='';
  if(workerId){
    output=(await exec('bb',['thread','output',workerId,'--json'])).stdout;
    // Only this newly created hidden test worker is cleaned up.
    await exec('bb',['thread','archive',workerId]);
    await exec('bb',['thread','stop',workerId]);
  }
  const rows=[...receipts.values()];
  const passed=!fault&&rows.some(r=>r.kind==='bb_spawn_thread'&&r.status==='started')&&rows.some(r=>r.kind==='bb_tell_thread'&&r.status==='sent')&&rows.some(r=>r.kind==='bb_stop_thread'&&r.status==='stopped')&&output.includes('VOICE_MANAGER_FOLLOWUP_OK')&&peak>100;
  console.log(JSON.stringify({passed,workerId,peak,output,transcript}));
  if(!passed)process.exitCode=1;
});
