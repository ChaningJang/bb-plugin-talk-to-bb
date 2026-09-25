// Created: 2026-09-15. Spoken tool-routing test with a simulated browser acknowledgment.
// This does NOT verify actual browser navigation. Pass mono PCM16 at 16 kHz.
import WebSocket from 'ws';
import { readFile } from 'node:fs/promises';
const pcm=await readFile(process.argv[2]);
if(pcm.length<32000||pcm.length%2)throw Error('Provide at least one second of raw PCM16 input.');
const base=process.env.BB_SERVER_URL||'http://127.0.0.1:38886';
const need=(k)=>{const v=process.env[k];if(!v){console.error(`Set ${k} (see the header of this probe).`);process.exit(2);}return v;};
const context={threadId:need('PROBE_PARENT_THREAD_ID'),projectId:need('PROBE_PROJECT_ID')};
const state=await fetch(`${base}/api/v1/plugins/talk-to-bb/rpc/status`,{method:'POST',headers:{'content-type':'application/json'},body:'null'}).then(r=>r.json());
if(!state.result?.configured||state.result.active)throw Error('Voice unconfigured or already in use.');
const ws=new WebSocket(`${base.replace(/^http/,'ws')}/api/v1/plugins/talk-to-bb/http/voice`,{origin:base});
let timer,deadline,afterAnswer,offset=0,peak=0,input='',transcript='',focused=false,fault=null;const tools=new Set();
const send=value=>ws.send(JSON.stringify(value));
const stop=()=>{clearInterval(timer);clearTimeout(deadline);clearTimeout(afterAnswer);if(ws.readyState===1)send({type:'stop'});};
deadline=setTimeout(stop,55000);
ws.on('open',()=>send({type:'start',context}));
ws.on('message',(data,binary)=>{
  if(binary){for(let i=0;i+1<data.length;i+=2)peak=Math.max(peak,Math.abs(data.readInt16LE(i)));return;}
  const e=JSON.parse(data);
  if(e.type==='ready')timer=setInterval(()=>{if(ws.readyState!==1)return;const chunk=Buffer.alloc(640);if(offset<pcm.length){pcm.copy(chunk,0,offset,offset+640);offset+=640;}ws.send(chunk);},20);
  if(e.type==='ui-action'){
    const ok=e.kind==='focus-thread'&&e.threadId===context.threadId;
    send({type:'ui-result',id:e.id,threadId:e.threadId,ok});
    if(ok)send({type:'context',context});
    console.log(JSON.stringify({simulatedFocusAcknowledgment:ok}));
  }
  if(e.type==='lookup'){console.log(JSON.stringify(e));if(e.state==='done')tools.add(e.name);}
  if(e.type==='action'&&e.receipt?.status==='focused'){focused=true;console.log(JSON.stringify(e));}
  if(e.type==='transcript'){
    if(e.speaker==='you')input+=e.text;
    else {transcript+=e.text;if(focused&&tools.has('bb_execution_options')){clearTimeout(afterAnswer);afterAnswer=setTimeout(stop,3500);}}
  }
  if(e.type==='fault'){fault=e.message;console.error(fault);stop();}
});
ws.on('error',e=>{fault=e.message;console.error(fault);});
ws.on('close',()=>{
  clearInterval(timer);clearTimeout(deadline);clearTimeout(afterAnswer);
  const passed=!fault&&focused&&tools.has('bb_execution_options')&&input.length>50&&peak>100;
  console.log(JSON.stringify({passed,simulatedBrowser:true,tools:[...tools],input,transcript,peak}));
  if(!passed)process.exitCode=1;
});
