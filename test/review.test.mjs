// Created: 2026-09-15. Quiet review mode: suppression, preserved input, persistence, resume, apply boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { UserRequests } from '../bb-manager.mjs';
import { TalkSession } from '../live-session.mjs';
import { NotificationGate, ReviewNotes, createReviewManager, compileNotes, resumableReview } from '../review-notes.mjs';

function memory(overrides={}) {
  const map=new Map();
  return {map,
    get:async key=>map.has(key)?structuredClone(map.get(key)):undefined,
    set:async(key,value)=>{if(overrides.rejectPrefix&&key.startsWith(overrides.rejectPrefix))return;map.set(key,structuredClone(value));},
    list:async prefix=>[...map.keys()].filter(k=>k.startsWith(prefix)),
  };
}
function fixture({store=memory(),clock=()=>1758000000000}={}) {
  const requests=new UserRequests();const states=[];
  const gate=new NotificationGate({policy:'immediate',clock});
  const manage=createReviewManager({store,requests,sessionId:'session_1',originThreadId:'thr_proposal',gate,clock,onState:s=>states.push(s)});
  const say=(text,at=0)=>{requests.append(text,at,true);return text;};
  return {store,requests,gate,manage,states,say};
}
const START={topic:'the proposal',anchorThreadId:'thr_proposal',artifact:'Pilot proposal draft',notifications:'hold',
  request:'Just collect my comments, stay quiet while I go through this'};
// The comments the user speaks while reading, in order.
const COMMENTS=[
  ['The intro spends too long on methodology','comment'],
  ['Pricing table should show the three-month option first','correction'],
  ['We are not naming the pilot work in this one','decision'],
  ['Ask Jordan whether the March dates still hold','todo'],
];

test('a multi-comment review yields ordered notes and holds every worker update silently',async()=>{
  const f=fixture();f.say(START.request);
  const started=await f.manage('bb_review_start',START);
  assert.equal(started.review.active,true);
  assert.equal(started.review.anchor.threadId,'thr_proposal');
  assert.equal(f.gate.policy,'hold');

  const spoken=[];
  // Mirrors the server branch: a held decision never reaches session.commentary.append.
  const workerUpdate=(threadId,title,state)=>{const d=f.gate.offer({threadId,title,state});if(d.speak)spoken.push(title);return d;};

  const seqs=[];
  for(const [index,[text,kind]] of COMMENTS.entries()) {
    f.say(text,index*10000);
    workerUpdate(`thr_w${index}`,`Unrelated worker ${index}`,'replied');   // fires mid-dictation
    const result=await f.manage('bb_review_note',{text,kind,anchor:null,request:text});
    assert.equal(result.persisted,true);assert.equal(result.duplicate,false);
    seqs.push(result.seq);
  }
  assert.deepEqual(seqs,[1,2,3,4]);
  assert.deepEqual(spoken,[],'no worker update may be spoken during review');
  assert.equal(f.gate.heldCount,4);

  const listed=await f.manage('bb_review_list',{});
  assert.deepEqual(listed.notes.map(n=>n.text),COMMENTS.map(c=>c[0]));
  assert.deepEqual(listed.notes.map(n=>n.kind),COMMENTS.map(c=>c[1]));
  assert.equal(listed.held,4);

  f.say('Okay, that is everything');
  const ended=await f.manage('bb_review_end',{request:'Okay, that is everything'});
  assert.equal(ended.ended,true);
  assert.deepEqual(ended.notes.map(n=>n.seq),[1,2,3,4]);
  assert.equal(ended.updates.length,4,'held updates are released once review ends');
  assert.match(ended.summary,/Pricing table should show the three-month option first/);
  assert.equal(f.manage.state().active,false);
});

test('a repeated comment is not appended twice and the verbatim request is preserved',async()=>{
  const f=fixture();f.say(START.request);await f.manage('bb_review_start',START);
  const said='The intro spends too long on methodology';
  f.say(said);
  const first=await f.manage('bb_review_note',{text:'Intro is too long on methodology',kind:'comment',anchor:null,request:said});
  const again=await f.manage('bb_review_note',{text:'Intro is too long on methodology',kind:'comment',anchor:null,request:said});
  assert.equal(first.duplicate,false);assert.equal(again.duplicate,true);assert.equal(again.seq,first.seq);
  assert.equal(f.manage.state().noteCount,1);
  const listed=await f.manage('bb_review_list',{});
  assert.equal(listed.notes[0].quote,said,'the user’s own words are kept alongside the recorded wording');
  // The same words about a different part of the artifact are a genuinely new note.
  const elsewhere=await f.manage('bb_review_note',{text:'Intro is too long on methodology',kind:'comment',anchor:'appendix',request:said});
  assert.equal(elsewhere.duplicate,false);assert.equal(elsewhere.seq,2);
});

test('an adopted alternative is appended beneath the original comment, never over it',async()=>{
  const f=fixture();f.say(START.request);await f.manage('bb_review_start',START);
  const said='The intro spends too long on methodology';f.say(said);
  const {seq}=await f.manage('bb_review_note',{text:said,kind:'comment',anchor:null,request:said});
  const accept='Yes, use that — cut it to two lines and move methodology to the appendix';f.say(accept);
  const adopted=await f.manage('bb_review_adopt',{seq,alternative:'Cut the intro to two lines; methodology moves to the appendix',request:accept});
  assert.equal(adopted.original,said,'the original comment is unchanged');
  assert.deepEqual(adopted.adopted,['Cut the intro to two lines; methodology moves to the appendix']);
  const repeat=await f.manage('bb_review_adopt',{seq,alternative:'Cut the intro to two lines; methodology moves to the appendix',request:accept});
  assert.equal(repeat.duplicate,true);assert.deepEqual(repeat.adopted,adopted.adopted);
  const summary=compileNotes({topic:'the proposal',anchor:{threadId:'thr_proposal'},startedAt:'x',notes:f.manage.state().notes.map(n=>({...n,quote:said,adopted:[{text:n.adopted[0]}]}))});
  assert.match(summary,/said: “The intro spends too long on methodology”/);
  assert.match(summary,/adopted instead: Cut the intro to two lines/);
});

test('an unconfirmed write fails loudly so nothing can be reported as saved',async()=>{
  const f=fixture({store:memory({rejectPrefix:'review-note:'})});
  f.say(START.request);await f.manage('bb_review_start',START);
  const said='Pricing table should show the three-month option first';f.say(said);
  await assert.rejects(f.manage('bb_review_note',{text:said,kind:'correction',anchor:null,request:said}),/could not be confirmed as saved/);
  assert.equal(f.manage.state().noteCount,0);
});

test('an existing sequence number is never overwritten, even when the index missed it',async()=>{
  const store=memory();
  await store.set('review-note:rev_x:000001',{key:'review-note:rev_x:000001',reviewId:'rev_x',seq:1,text:'earlier note',kind:'comment',anchor:null,adopted:[],quote:'earlier note'});
  const blind={...store,list:async()=>[]};   // index under-reports; the write path must still not clobber
  const notes=new ReviewNotes({store:blind,reviewId:'rev_x'});
  const {note}=await notes.append({text:'a later note',kind:'comment',anchor:null,quote:'a later note',at:'now'});
  assert.equal(note.seq,2);
  assert.equal((await store.get('review-note:rev_x:000001')).text,'earlier note');
});

test('notes survive a dropped connection and the next session resumes the same ordered review',async()=>{
  const store=memory();
  const first=fixture({store});first.say(START.request);await first.manage('bb_review_start',START);
  for(const [text,kind] of COMMENTS.slice(0,2)){first.say(text);await first.manage('bb_review_note',{text,kind,anchor:null,request:text});}
  const reviewId=first.manage.state().reviewId;

  // New websocket, new session id, same durable store.
  const requests=new UserRequests();
  const second=createReviewManager({store,requests,sessionId:'session_2',originThreadId:'thr_proposal',clock:()=>1758000000000});
  const recoverable=await second('bb_review_list',{});
  assert.equal(recoverable.active,false);assert.equal(recoverable.recoverable,true);
  assert.deepEqual(recoverable.notes.map(n=>n.seq),[1,2]);

  const resumed=await second.resume({anchorThreadId:'thr_proposal'});
  assert.equal(resumed.reviewId,reviewId);assert.equal(resumed.noteCount,2);
  requests.append('Ask Jordan whether the March dates still hold',0,true);
  const next=await second('bb_review_note',{text:'Ask Jordan whether the March dates still hold',kind:'todo',anchor:null,request:'Ask Jordan whether the March dates still hold'});
  assert.equal(next.seq,3,'appending continues the existing order');
  assert.equal(await resumableReview(store,{anchorThreadId:'thr_other'})!==null,true);
});

test('review mode blocks agent actions, allows questions, and crosses the apply boundary only on request',async()=>{
  const f=fixture();f.say(START.request);await f.manage('bb_review_start',START);
  for(const name of ['bb_spawn_thread','bb_tell_thread','bb_stop_thread'])
    assert.throws(()=>f.manage.guard(name,{threadId:'thr_proposal'}),/Review mode is on/);
  // Reads and browser focus are untouched, so the user can still ask a question mid-review.
  for(const name of ['bb_read_thread','bb_search','bb_overview','bb_focus_thread'])
    assert.doesNotThrow(()=>f.manage.guard(name,{threadId:'thr_proposal'}));

  const ask='Send these to the proposal thread and have it make the changes';f.say(ask);
  const handoff=await f.manage('bb_review_handoff',{target:'thread',threadId:'thr_proposal',grants:1,request:ask});
  assert.match(handoff.summary,/# Review notes/);
  assert.doesNotThrow(()=>f.manage.guard('bb_tell_thread',{threadId:'thr_proposal'}),'the granted instruction goes through');
  assert.throws(()=>f.manage.guard('bb_tell_thread',{threadId:'thr_proposal'}),/Review mode is on/,'the permission is single use');

  f.say(ask);
  await f.manage('bb_review_handoff',{target:'thread',threadId:'thr_proposal',grants:1,request:ask});
  assert.throws(()=>f.manage.guard('bb_tell_thread',{threadId:'thr_other'}),/Review mode is on/,'only the named thread is permitted');

  const summaryOnly=await f.manage('bb_review_handoff',{target:'summary',threadId:null,grants:1,request:ask});
  assert.match(summaryOnly.permits,/text only/);
  assert.throws(()=>f.manage.guard('bb_tell_thread',{threadId:'thr_proposal'}),/Review mode is on/,'a summary-only handoff withdraws the outstanding permission');
  f.say('Alright, go ahead now');
  await f.manage('bb_review_end',{request:'Alright, go ahead now'});
  assert.doesNotThrow(()=>f.manage.guard('bb_spawn_thread',{}),'ending review restores agent actions');
});

test('a specifically awaited thread is announced once; stale repeats are dropped',()=>{
  const gate=new NotificationGate({policy:'hold'});
  gate.watch('thr_citations',true);
  assert.equal(gate.offer({threadId:'thr_citations',title:'Citation orchestrator',state:'replied'}).speak,true);
  assert.equal(gate.offer({threadId:'thr_citations',title:'Citation orchestrator',state:'replied'}).suppressed,true);
  assert.equal(gate.offer({threadId:'thr_citations',title:'Citation orchestrator',state:'needs-input'}).speak,true);
  assert.equal(gate.offer({threadId:'thr_other',title:'Something else',state:'replied'}).held,true);
  assert.equal(gate.heldCount,1);
  const drained=gate.drain('requested');
  assert.equal(drained.items.length,1);assert.match(drained.text,/Something else/);
  assert.equal(gate.drain('requested').items.length,0,'a drained update is not replayed');
});

test('held updates collapse per thread and release on a conversational gap under the pause policy',()=>{
  let now=0;const gate=new NotificationGate({policy:'pause',pauseMs:12000,clock:()=>now});
  gate.markActivity(0);
  gate.offer({threadId:'thr_a',title:'Worker A',state:'replied'});
  gate.offer({threadId:'thr_a',title:'Worker A',state:'needs-input'});
  gate.offer({threadId:'thr_b',title:'Worker B',state:'failed'});
  assert.equal(gate.heldCount,2,'repeat states for one thread collapse into its latest');
  now=5000;assert.equal(gate.sweep(now),null,'no release while the user is still talking');
  now=6000;gate.markActivity(now);
  now=17000;assert.equal(gate.sweep(now),null,'the gap is measured from the last activity');
  now=19000;const drained=gate.sweep(now);
  assert.equal(drained.reason,'pause');
  assert.deepEqual(drained.items.map(i=>i.state),['needs-input','failed']);
  assert.equal(gate.sweep(20000),null);
});

test('muting audio and pausing the microphone never change review policy, and review never mutes audio',()=>{
  const sent=[];
  const session=new TalkSession({key:'test',query:async()=>({})});
  session.socket={readyState:1,bufferedAmount:0,send:v=>sent.push(JSON.parse(v)),close(){},terminate(){}};
  session.ready=true;
  session.mute(true);
  assert.equal(session.reviewing,false,'Quiet does not start a review');
  session.reviewMode(true,{topic:'the proposal'});
  assert.equal(session.audible,false,'review does not touch the audio gate');
  assert.equal(session.reviewing,true);
  session.mute(false);
  assert.equal(session.reviewing,true,'resuming audio does not end a review');
  session.reviewMode(true,{});
  assert.equal(sent.filter(e=>String(e.content).includes('review mode is now ON')).length,1,'no repeated mode announcements');
  session.reviewMode(false,{});
  assert.equal(session.audible,true);
  assert.match(sent.at(-1).content,/review mode is now OFF/);
  session.clear();
});
