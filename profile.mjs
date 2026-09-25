// Created: 2026-09-25. Who the voice manager works for, from the plugin settings.
// The prompts and worker briefs read it, so nothing personal is written into the code.
export const profile = { name: '', machine: '', workerRules: '' };
export function setProfile({ name = '', machine = '', workerRules = '' } = {}) {
  profile.name = String(name).trim();
  profile.machine = String(machine).trim();
  // Extra house rules appended to every worker brief (tools, repo conventions, handoffs).
  profile.workerRules = String(workerRules).trim().slice(0, 4000);
}
/** "Sam's" when a name is set, otherwise "the user's". */
export const possessive = () => (profile.name ? `${profile.name}’s` : 'the user’s');
export const person = () => profile.name || 'the user';
export function machineRule() {
  return profile.machine
    ? `Prefer ${profile.machine} environments for normal work; use another machine only for work bound to it.`
    : 'Prefer an online, always-on machine for normal work; use another machine only for work bound to it.';
}
