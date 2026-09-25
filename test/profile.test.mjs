// Created: 2026-09-25. Prompts and briefs carry the configured person, and nobody's name by default.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setProfile } from '../profile.mjs';
import { backendInstructions, config } from '../live-session.mjs';
import { workerBrief } from '../bb-manager.mjs';

const brief = () => workerBrief({ request: 'look into it', brief: 'Investigate the failing build and report back.' });

test('with no profile set, prompts and briefs name no one', () => {
  setProfile({});
  const text = backendInstructions({}) + config({}).instructions + brief();
  assert.match(text, /the user’s BB voice manager/);
  assert.match(text, /Task delegated by the user through Talk to BB/);
  assert.match(text, /always-on machine/);
  assert.doesNotMatch(text, /Mac mirror|GOOGLE_WORKSPACE|handoffs\/live|owed ledger/);
});

test('a configured name, machine and house rules reach the prompts and briefs', () => {
  setProfile({ name: 'Sam', machine: 'build-box', workerRules: 'Leave a handoff note under notes/.' });
  assert.match(backendInstructions({}), /Sam’s BB voice manager[\s\S]*Prefer build-box environments/);
  assert.match(config({}).instructions, /Sam’s conversational companion/);
  assert.match(brief(), /Task delegated by Sam[\s\S]*Leave a handoff note under notes\/\./);
  setProfile({});
});
