// Created: 2026-09-15.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createManager, UserRequests, profiles } from '../bb-manager.mjs';
import { FocusRequests } from '../focus-ui.mjs';

function fixture(){
  const map=new Map();const calls=[];const receipts=[];const requests=new UserRequests();
  const store={get:async key=>map.get(key),set:async(key,value)=>{map.set(key,structuredClone(value));},list:async()=>[...map.keys()]};
  let fail=false;
  const cli=async args=>{
    calls.push(args);
    if(args[0]==='environment')return {id:'env_a',projectId:'proj_a',status:'ready',hostId:'host_a',isGitRepo:true,defaultBranch:'main'};
    if(args[0]==='provider')return [{id:profiles.general.model},{id:profiles.probe.model}];
    if(args[1]==='show')return {thread:{id:args[2],title:'Source thread',status:'idle'}};
    if(args[1]==='spawn'){
      assert.ok([...map.values()].some(r=>r.status==='dispatching'),'receipt must precede dispatch');
      if(fail)throw new Error('timeout');
      return {thread:{id:'thr_new'},delivery:'sent'};
    }
    if(args[1]==='tell')return {delivery:'queued',queuedMessage:{waitingOn:{kind:'interaction'}}};
    return {};
  };
  const make=()=>createManager({cli,store,requests,sessionId:'session_1',originThreadId:'thr_parent',focus:async()=>{},onReceipt:r=>receipts.push(r)});
  return {map,calls,requests,make,receipts,setFail:()=>{fail=true;}};
}
const spawn={projectId:'proj_a',environmentId:'env_a',parentThreadId:null,title:'Voice test task',brief:'Reply with the requested validation phrase. Make no file changes.',profile:'general',isolatedWorktree:false,request:'Please start an agent to test this feature'};

test('thread-source instructions cannot authorize actions without matching live user input',async()=>{
  const f=fixture();f.requests.append('What is happening in my threads?',0,true);
  await assert.rejects(f.make()('bb_spawn_thread',spawn),/not in this live conversation/);
  assert.equal(f.calls.length,0);
});
test('short spoken instructions and standalone whitespace transcript deltas remain usable',async()=>{
  const f=fixture();f.requests.append('Stop',10,true);f.requests.append(' ',20);f.requests.append('it',30);
  const result=await f.make()('bb_stop_thread',{threadId:'thr_a',request:'Stop it'});
  assert.equal(result.receipt.status,'stopped');
  assert.equal(f.calls.filter(c=>c[1]==='stop').length,1);
});
test('spawn is parented, explicit about model and permissions, preserves constraints, and is deduplicated',async()=>{
  const f=fixture();f.requests.append(spawn.request,0,true);const manage=f.make();
  const [a,b]=await Promise.all([manage('bb_spawn_thread',spawn),manage('bb_spawn_thread',spawn)]);
  assert.equal(a.receipt.threadId,'thr_new');assert.equal(b.receipt.id,a.receipt.id);
  const commands=f.calls.filter(c=>c[1]==='spawn');assert.equal(commands.length,1);
  const cmd=commands[0];assert.equal(cmd[cmd.indexOf('--parent-thread')+1],'thr_parent');
  assert.equal(cmd[cmd.indexOf('--model')+1],profiles.general.model);
  assert.equal(cmd[cmd.indexOf('--permission-mode')+1],'auto');
  assert.match(cmd[cmd.indexOf('--prompt')+1],/Do not send email or post Slack/);
  // Same receipt is also recovered by a reconstructed manager, not just its in-memory map.
  const repeat=await f.make()('bb_spawn_thread',spawn);assert.equal(repeat.reused,true);
  assert.equal(f.calls.filter(c=>c[1]==='spawn').length,1);
});
test('uncertain dispatch persists and cannot be automatically replayed',async()=>{
  const f=fixture();f.setFail();f.requests.append(spawn.request,0,true);
  const a=await f.make()('bb_spawn_thread',spawn);assert.equal(a.receipt.status,'uncertain');
  const b=await f.make()('bb_spawn_thread',spawn);assert.equal(b.receipt.status,'uncertain');
  assert.equal(f.calls.filter(c=>c[1]==='spawn').length,1);
});
test('wrong-project environment is rejected before spawning',async()=>{
  const f=fixture();f.requests.append(spawn.request,0,true);
  await assert.rejects(f.make()('bb_spawn_thread',{...spawn,projectId:'proj_wrong'}),/belonging/);
  assert.equal(f.calls.filter(c=>c[1]==='spawn').length,0);
});
test('queued instruction is reported as queued and preserves the user exclusion',async()=>{
  const f=fixture();const request="Have the agent fix the duration; I'll add the video link myself";f.requests.append(request,0,true);
  const r=await f.make()('bb_tell_thread',{threadId:'thr_a',mode:'steer',message:'Change duration to one hour. Do not add the video link.',request});
  assert.equal(r.receipt.status,'queued');assert.equal(r.receipt.waitingOn,'interaction');
  assert.match(f.calls.find(c=>c[1]==='tell')[3],/Do not add the video link/);
});
test('code worktree uses verified host and branch without mixing environment flags',async()=>{
  const f=fixture();f.requests.append(spawn.request,0,true);await f.make()('bb_spawn_thread',{...spawn,isolatedWorktree:true});
  const cmd=f.calls.find(c=>c[1]==='spawn');assert.equal(cmd[cmd.indexOf('--machine')+1],'host_a');
  assert.equal(cmd[cmd.indexOf('--base-branch')+1],'main');assert.equal(cmd.includes('--environment'),false);
});
test('focus succeeds only after the target thread is observed; cancellation reports failure',()=>{
  const sent=[],navigated=[];let current='thr_a';
  const focus=new FocusRequests({navigate:id=>navigated.push(id),currentThread:()=>current,send:value=>sent.push(value)});
  focus.open({id:'one',kind:'focus-thread',threadId:'thr_b'});assert.deepEqual(navigated,['thr_b']);assert.equal(sent.length,0);
  focus.observe('thr_a');assert.equal(sent.length,0);
  current='thr_b';focus.observe(current);assert.equal(sent[0].ok,true);
  focus.open({id:'two',kind:'focus-thread',threadId:'thr_c'});focus.cancel();assert.equal(sent[1].ok,false);
});
test('focus tool reports focus-failed when the browser cannot confirm it',async()=>{
  const f=fixture();f.requests.append('Please open the staffing thread',0,true);
  const manage=createManager({cli:async()=>({thread:{id:'thr_a',title:'Staffing'}}),store:{get:async()=>null,set:async()=>{},list:async()=>[]},requests:f.requests,sessionId:'x',focus:async()=>{throw Error('timeout');}});
  const r=await manage('bb_focus_thread',{threadId:'thr_a',request:'Please open the staffing thread'});assert.equal(r.receipt.status,'focus-failed');
});
