// Created: 2026-09-15. Real voice + BB CLI integration check; incurs a short voice session.
import WebSocket from 'ws';
import { readFile } from 'node:fs/promises';
const pcm=process.argv[2]?await readFile(process.argv[2]):null;
if(pcm && (pcm.length<32000 || pcm.length%2))throw new Error('Provide nonempty mono PCM16 at 16 kHz (at least one second).');
let offset=0,inputTranscript='';
const base=process.env.BB_SERVER_URL||'http://127.0.0.1:38886';
const state=await fetch(`${base}/api/v1/plugins/talk-to-bb/rpc/status`,{method:'POST',headers:{'content-type':'application/json'},body:'null'}).then(r=>r.json());
if(!state.result?.configured||state.result.active)throw new Error('Voice unconfigured or already in use; probe will not interrupt it.');
const ws=new WebSocket(`${base.replace(/^http/,'ws')}/api/v1/plugins/talk-to-bb/http/voice`,{origin:base});
let timer,deadline,afterAnswer,peak=0,audioBytes=0,transcript='',fault=null;
const lookups=[];
const stop=()=>{clearInterval(timer);clearTimeout(deadline);clearTimeout(afterAnswer);if(ws.readyState===1)ws.send(JSON.stringify({type:'stop'}));};
deadline=setTimeout(stop,55000);
ws.on('open',()=>ws.send(JSON.stringify({type:'start',context:{threadId:null,projectId:null}})));
ws.on('message',(data,binary)=>{
  if(binary){audioBytes+=data.length;for(let i=0;i+1<data.length;i+=2)peak=Math.max(peak,Math.abs(data.readInt16LE(i)));return;}
  const e=JSON.parse(data);
  if(e.type==='ready'){
    console.log('Voice ready.');timer=setInterval(()=>{
      if(ws.readyState!==1)return;
      if(pcm&&offset<pcm.length){const chunk=Buffer.alloc(640);pcm.copy(chunk,0,offset,offset+640);offset+=640;ws.send(chunk);}
      else ws.send(Buffer.alloc(640));
    },20);
    if(!pcm)ws.send(JSON.stringify({type:'ask',text:'Find the older thread called Explore ChatGPT Live API capabilities, read its conversation, and tell me briefly what audio problem was fixed and what still needed a human test. Use BB search and read the matching thread.'}));
  }
  if(e.type==='lookup'){console.log(JSON.stringify(e));if(e.state==='done')lookups.push(e.name);}
  if(e.type==='transcript'&&e.speaker==='you')inputTranscript+=e.text;
  if(e.type==='transcript'&&e.speaker==='assistant'){
    transcript+=e.text;
    if(lookups.includes('bb_read_thread')){clearTimeout(afterAnswer);afterAnswer=setTimeout(stop,4000);}
  }
  if(e.type==='fault'){fault=e.message;console.error(fault);stop();}
});
ws.on('error',error=>{fault=error.message;console.error(fault);});
ws.on('close',()=>{
  clearInterval(timer);clearTimeout(deadline);clearTimeout(afterAnswer);
  const passed=!fault&&lookups.includes('bb_search')&&lookups.includes('bb_read_thread')&&peak>100&&transcript.length>40&&(!pcm||inputTranscript.length>40);
  console.log(JSON.stringify({passed,lookups,audioBytes,peak,inputTranscript,transcript}));
  if(!passed)process.exitCode=1;
});
