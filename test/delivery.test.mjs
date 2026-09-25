// Created: 2026-09-15. Acceptance for the merged notification delivery path.
// Nothing here re-implements a condition: it drives createWorkerEventHandler (what server.ts
// registers) against a real TalkSession, a real createReviewManager and a real NotificationGate,
// wired together exactly as server.ts wires them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkerEventHandler, WORKER_EVENTS } from '../worker-events.mjs';
import { TalkSession } from '../live-session.mjs';
import { createReviewManager, NotificationGate } from '../review-notes.mjs';
import { UserRequests } from '../bb-manager.mjs';

const ago = ms => new Date(Date.now() - ms).toISOString();
function store() {
  const map = new Map();
  return { map, get: async k => map.get(k), set: async (k, v) => { map.set(k, structuredClone(v)); },
    delete: async k => { map.delete(k); }, list: async (prefix = '') => [...map.keys()].filter(k => k.startsWith(prefix)) };
}
const receipt = (over = {}) => ({ key: `action:s1:${over.id}`, id: over.id, sessionId: 's1',
  kind: 'bb_spawn_thread', status: 'started', at: ago(60 * 60000), threadId: 'thr_worker',
  projectId: 'proj_a', title: 'Staffing sweep', request: 'have an agent sweep staffing',
  summary: 'Sweep staffing', ...over });
const threadOf = (id, title, updatedAt = 1789000000000) => ({ id, title, updatedAt });

/** The same objects and the same wiring server.ts builds, minus the OpenAI socket. */
async function wired({ policy = 'hold', kv = store() } = {}) {
  const sent = [], states = [], notices = [];
  const requests = new UserRequests();
  const session = new TalkSession({ key: 'test', query: async () => ({}) });
  session.socket = { readyState: 1, bufferedAmount: 0, send: v => sent.push(JSON.parse(v)), close() {}, terminate() {} };
  session.ready = true;
  session.on('deferred-notice', n => notices.push(n));
  let reviewing = false;
  const review = createReviewManager({ store: kv, requests, sessionId: 's1', originThreadId: 'thr_a',
    gate: new NotificationGate({ policy: 'immediate' }),
    onState: value => { states.push(value); if (value.active !== reviewing) { reviewing = value.active; session.reviewMode(value.active, value); } } });
  session.reviewGate = review.gate;
  session.on('deferred-notice', notice => { if (notice?.reason === 'review') review.noteHeld(); });
  const handle = createWorkerEventHandler({ store: kv, session: () => session, publish: () => {} });
  const commentary = () => sent.filter(e => e.type === 'session.commentary.append');
  const startReview = async () => {
    requests.append('just collect my comments on the proposal', 0, true);
    return review('bb_review_start', { topic: 'the proposal', anchorThreadId: 'thr_a', artifact: null,
      notifications: policy, request: 'just collect my comments on the proposal' });
  };
  return { kv, sent, states, notices, session, review, handle, commentary, requests, startReview };
}

test('acceptance: an unrelated worker update is held while Review is on, and nothing is spoken', async () => {
  const w = await wired();
  await w.kv.set('action:s1:one', receipt({ id: 'one' }));
  await w.startReview();
  const before = w.commentary().length;
  const result = await w.handle('thread.idle', { thread: threadOf('thr_worker', 'Staffing sweep'), lastAssistantText: 'Wrote the draft' });
  assert.equal(result.spoken, false, 'a held update must not be spoken');
  assert.equal(w.commentary().length, before, 'dictation must not be interrupted');
  assert.equal(w.review.gate.heldCount, 1);
  assert.equal((await w.kv.get('action:s1:one')).workerState, 'replied', 'the receipt still records it');
  assert.deepEqual(w.notices.map(n => n.reason), ['review']);
  assert.equal(w.session.deferred.length, 0, 'a gate-held notice must not also enter the quiet queue');
  assert.equal(w.review.state().held, 1, 'and the panel count must move');
  w.session.clear();
});

test('acceptance: Quiet then un-mute while Review stays on emits nothing', async () => {
  const w = await wired();
  await w.kv.set('action:s1:one', receipt({ id: 'one' }));
  await w.startReview();
  await w.handle('thread.idle', { thread: threadOf('thr_worker', 'Staffing sweep'), lastAssistantText: 'done' });
  const before = w.commentary().length;
  w.session.mute(true);
  await w.handle('thread.failed', { thread: threadOf('thr_worker', 'Staffing sweep', 1789000001111), error: 'boom' });
  w.session.mute(false);
  assert.equal(w.commentary().length, before, 'un-muting must not release a review-held batch');
  assert.equal(w.session.reviewing, true, 'and un-muting must not end the review');
  assert.equal(w.review.gate.heldCount, 1, 'still held, collapsed to the latest state for that thread');
  w.session.clear();
});

test('acceptance: leaving Review releases each held update exactly once', async () => {
  const w = await wired();
  await w.kv.set('action:s1:one', receipt({ id: 'one' }));
  await w.kv.set('action:s1:two', receipt({ id: 'two', threadId: 'thr_other', title: 'Contracts', at: ago(50 * 60000) }));
  await w.startReview();
  await w.handle('thread.idle', { thread: threadOf('thr_worker', 'Staffing sweep'), lastAssistantText: 'draft ready' });
  await w.handle('interaction.pending', { thread: threadOf('thr_other', 'Contracts'), interaction: {} });
  assert.equal(w.review.gate.heldCount, 2);
  const before = w.commentary().length;
  w.requests.append('okay, I am done reviewing', 9000, true);
  const ended = await w.review('bb_review_end', { request: 'okay, I am done reviewing' });
  assert.equal(ended.updates.length, 2, 'both held updates come back on ending the review');
  assert.equal(w.session.reviewing, false);
  // The release itself goes through the one delivery path, and says it once.
  assert.equal(w.session.announceBatch(ended.updates, 'review'), true);
  const spoken = w.commentary().slice(before).filter(e => /changed state/.test(e.content));
  assert.equal(spoken.length, 1, 'one batch, not one interruption each');
  assert.match(spoken[0].content, /2 threads you were asked to manage changed state/);
  // Nothing is left to release, and a repeat of the same state stays suppressed.
  assert.equal(w.review.gate.heldCount, 0);
  assert.equal((await w.handle('thread.idle', { thread: threadOf('thr_worker', 'Staffing sweep') })).spoken, false,
    'an already-reported state must not be re-announced after the release');
  w.session.clear();
});

test('acceptance: a reconnect keeps the notes, visibly restores Review, and replays nothing', async () => {
  const first = await wired();
  await first.kv.set('action:s1:one', receipt({ id: 'one' }));
  await first.startReview();
  first.requests.append('the pricing table is too dense', 4000, true);
  await first.review('bb_review_note', { text: 'The pricing table is too dense', kind: 'correction', anchor: null,
    request: 'the pricing table is too dense' });
  await first.handle('thread.idle', { thread: threadOf('thr_worker', 'Staffing sweep'), lastAssistantText: 'draft ready' });
  await first.review.saveGate();
  first.session.clear();

  // A new session over the SAME storage, wired the same way.
  const next = await wired({ kv: first.kv });
  const restored = await next.review.resume({ anchorThreadId: 'thr_a' });
  assert.equal(restored.active, true, 'the mode itself must come back');
  assert.equal(restored.noteCount, 1, 'and the notes with it');
  assert.equal(restored.notes[0].text, 'The pricing table is too dense');
  // Visibly: the client was told, and the model was told, on the transition.
  assert.ok(next.states.some(s => s.active && s.noteCount === 1), 'the panel state must be published');
  assert.equal(next.session.reviewing, true);
  const announced = next.sent.filter(e => e.type === 'session.instructions.append' && /review mode is now ON/i.test(e.content));
  assert.equal(announced.length, 1, 'the restoration must be announced once, not silently applied');
  // Not replayed: the carried-over notice is still held, and marked as history when released.
  assert.equal(next.review.gate.heldCount, 1);
  assert.equal(next.commentary().filter(e => /changed state/.test(e.content)).length, 0);
  const drained = next.review.gate.drain('requested');
  assert.equal(drained.items[0].restored, true);
  next.session.announceBatch(drained.items, 'review');
  const batch = next.commentary().at(-1).content;
  assert.match(batch, /held from a PREVIOUS session and are historical/);
  assert.match(batch, /do not present any of them as current/);
  // And the same state arriving again after the drain stays silent.
  assert.equal((await next.handle('thread.idle', { thread: threadOf('thr_worker', 'Staffing sweep') })).spoken, false);
  next.session.clear();
});

test('acceptance: with no review open, the same path speaks immediately, and both dedupes hold', async () => {
  const w = await wired();
  await w.kv.set('action:s1:one', receipt({ id: 'one' }));
  const first = await w.handle('thread.idle', { thread: threadOf('thr_worker', 'Staffing sweep'), lastAssistantText: 'draft ready' });
  assert.equal(first.spoken, true, 'outside a review the update is spoken at once');
  assert.match(w.commentary().at(-1).content, /does not establish that the task succeeded/);
  // Receipt-event dedupe: the identical event changes nothing and says nothing.
  const repeat = await w.handle('thread.idle', { thread: threadOf('thr_worker', 'Staffing sweep'), lastAssistantText: 'draft ready' });
  assert.deepEqual(repeat.updates, []);
  assert.equal(repeat.spoken, false);
  // Gate spoken-state dedupe: a NEW event for a state already spoken is still suppressed.
  const newer = await w.handle('thread.idle', { thread: threadOf('thr_worker', 'Staffing sweep', 1789000009999), lastAssistantText: 'draft ready' });
  assert.equal(newer.updates.length, 1, 'the receipt records the newer event');
  assert.equal(newer.spoken, false, 'but an already-spoken state is not repeated');
  assert.deepEqual(WORKER_EVENTS, ['thread.idle', 'thread.failed', 'interaction.pending']);
  w.session.clear();
});
