// Created: 2026-09-15. The production worker-event dispatcher, as one testable module.
// server.ts registers this and nothing else, so a test drives the same code the host does
// rather than a hand-copied version of its condition.
import { recentReceipts } from './bb-manager.mjs';
import { correlateWorkerEvent } from './reliability.mjs';

export const WORKER_EVENTS = ['thread.idle', 'thread.failed', 'interaction.pending'];

/**
 * One BB thread event in, one receipt updated and at most one spoken announcement out.
 * `session` and `publish` are read at call time because a voice session comes and goes
 * while the plugin stays loaded.
 * @param {{store:any,session:()=>any,publish?:(receipt:any)=>void,now?:()=>number}} deps
 */
export function createWorkerEventHandler({ store, session, publish = () => {}, now = Date.now }) {
  return async function handleWorkerEvent(event, data) {
    if (!WORKER_EVENTS.includes(event) || !data?.thread?.id) return { updates: [], announcement: null, spoken: false };
    const { updates, announcement } = correlateWorkerEvent({
      receipts: await recentReceipts(store), event, thread: data.thread,
      lastAssistantText: data.lastAssistantText ?? null, at: now(),
    });
    for (const next of updates) { await store.set(next.key, next); publish(next); }
    // Delivery policy lives in the session: review first, then quiet. There is no second path.
    const live = session();
    const spoken = Boolean(announcement && live && !live.closing && live.notifyWorker(announcement));
    return { updates, announcement, spoken };
  };
}
