// Created: 2026-09-15.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCapabilities, capabilitySchemas, parseFrontmatter, safeChild, safeRemotePath, score, fitToBudget, requiredInputs, LIMITS } from '../bb-capabilities.mjs';
import { toolDefinitions, createReader } from '../bb-read.mjs';

const HOST = 'host_local', OTHER = 'host_mac';
async function workspace() {
  const base = await mkdtemp(join(tmpdir(), 'bb-cap-'));
  const write = async (rel, text) => {
    await mkdir(join(base, rel, '..'), { recursive: true });
    await writeFile(join(base, rel), text);
  };
  // Canonical repository skills root: real on disk, invisible to `bb skill list`.
  await write('skills/il-diagnosis-one-screen/SKILL.md',
    '---\nname: il-diagnosis-one-screen\ndescription: IL methodology for behavioral diagnosis of a single product screen. Produces barrier analysis, redesign directions, and a UI mock prompt. Use when a client wants fast feedback on a specific screen before a full diagnosis.\nuser_invocable: true\n---\n\n# IL Diagnosis One Screen\n\nIntro line.\n\n## Required Inputs\n\n- A screenshot of the screen under review\n- The user action the screen is meant to produce\n\n## Steps\n\n- Do the thing\n');
  await write('skills/il-full-diagnosis/SKILL.md',
    '---\nname: il-full-diagnosis\ndescription: Full multi-screen behavioral diagnosis engagement across an entire product funnel.\n---\n\nBody.\n');
  // Same skill copied into two provider roots: one capability, not two.
  for (const root of ['.claude/skills', '.agents/skills']) {
    await write(`${root}/key-behavior/SKILL.md`,
      '---\nname: key-behavior\ndescription: Pick the one behavior a project should move.\n---\n\nBody.\n');
    // A description whose plain YAML scalar contains ": " — bb skill list returns null for these.
    await write(`${root}/proof-point/SKILL.md`,
      '---\nname: proof-point\ndescription: Research evidence for a recommendation. Good triggers include: "find evidence for...", "what does the science say".\nuser_invocable: true\n---\n\nBody.\n');
  }
  await write('.claude/commands/diagnosis-flow.md', '---\ndescription: "Run the diagnosis pipeline end to end"\n---\n\nSteps.\n');
  await write('.claude/agents/diagnosis_deck_reviewer.md', '---\ndescription: "Validates diagnosis decks"\nmode: subagent\n---\n\nRules.\n');
  return base;
}

function bb(base, { indexed = null, plugins = null, fail = {}, remoteBase = null } = {}) {
  const calls = [];
  const defaultIndex = [
    { id: 'skill_kb_claude', name: 'key-behavior', description: 'Pick the one behavior a project should move.', provider: 'claude-code', scope: 'provider-project', pluginId: null, filePath: join(base, '.claude/skills/key-behavior/SKILL.md') },
    { id: 'skill_kb_codex', name: 'key-behavior', description: 'Pick the one behavior a project should move.', provider: 'codex', scope: 'provider-project', pluginId: null, filePath: join(base, '.agents/skills/key-behavior/SKILL.md') },
    { id: 'skill_pp_claude', name: 'proof-point', description: null, provider: 'claude-code', scope: 'provider-project', pluginId: null, filePath: join(base, '.claude/skills/proof-point/SKILL.md') },
    { id: 'skill_pp_codex', name: 'proof-point', description: null, provider: 'codex', scope: 'provider-project', pluginId: null, filePath: join(base, '.agents/skills/proof-point/SKILL.md') },
    { id: 'skill_imp', name: 'impeccable', description: 'Design and critique frontend interfaces.', provider: 'claude-code', scope: 'plugin', pluginId: 'impeccable', filePath: null },
    { id: 'skill_off', name: 'offline-only', description: 'Lives in a plugin that is not running.', provider: 'claude-code', scope: 'plugin', pluginId: 'dormant', filePath: null },
  ];
  const cli = async args => {
    calls.push(args);
    const key = args.slice(0, 2).join(' ');
    if (fail[key]) throw new Error(fail[key]);
    if (key === 'project show') return { id: 'proj_a', name: 'demo', sources: [
      { id: 'src_local', hostId: HOST, path: base, isDefault: true },
      { id: 'src_mac', hostId: OTHER, path: '/Users/someone/demo', isDefault: false },
    ] };
    if (key === 'environment show') return { id: args[2], projectId: 'proj_a', hostId: HOST, path: base, isWorktree: false, status: 'ready' };
    if (key === 'machine list') return [{ id: HOST, name: 'build-server', status: 'online' }, { id: OTHER, name: 'the-mac', status: 'online' }];
    if (key === 'skill list') return { skills: indexed ?? defaultIndex };
    if (key === 'plugin list') return { plugins: plugins ?? [
      { id: 'impeccable', name: 'Impeccable', description: 'Frontend design skill bundle.', status: 'running', enabled: true, version: '1.0.0', provenance: 'git', cliCommand: null, capabilities: [{ kind: 'skill', id: 'impeccable' }] },
      { id: 'dormant', name: 'Dormant', description: 'Disabled plugin.', status: 'disabled', enabled: false, version: '0.1.0', provenance: 'builtin', cliCommand: null, capabilities: [{ kind: 'skill', id: 'offline-only' }] },
    ] };
    // The owning host answers these by reading ITS OWN filesystem. The caller never does.
    if (key === 'project files' || key === 'project paths') {
      const out = [];
      const walk = async (dir, rel) => {
        let items = [];
        try { items = await readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const item of items) {
          const next = rel ? `${rel}/${item.name}` : item.name;
          if (item.isDirectory()) await walk(join(dir, item.name), next);
          else if (item.isFile()) out.push({ path: next, name: item.name });
        }
      };
      await walk(remoteBase ?? base, '');
      const wanted = args[args.indexOf('--query') + 1];
      const rows = key === 'project files'
        ? out.filter(r => r.name === wanted)
        : out.filter(r => r.path.includes(wanted));
      return key === 'project files' ? { files: rows } : { paths: rows.map(r => ({ ...r, kind: 'file' })) };
    }
    if (key === 'project content') {
      const wanted = args[3];
      if (wanted.includes('..') || wanted.startsWith('/')) throw new Error('HTTP 400: Invalid file path');
      return { content: await readFile(join(remoteBase ?? base, wanted), 'utf8') };
    }
    if (key === 'plugin search') {
      // The real CLI matches the search string literally, so a spoken phrase returns nothing.
      const store = [
        { entryId: 'taskboard', pluginId: 'taskboard', displayName: 'Taskboard', description: 'A kanban board for tasks.', installed: false, compatible: true, marketplace: 'bb-community', marketplaceDisplayName: 'BB Community' },
        { entryId: 'oldboard', pluginId: 'oldboard', displayName: 'Old Board', description: 'A kanban board for tasks, for an older BB.', installed: false, compatible: false, incompatibleReason: 'requires bb <0.30', marketplace: 'third-party', marketplaceDisplayName: 'Someone Else' },
        { entryId: 'unrelated', pluginId: 'unrelated', displayName: 'Weather', description: 'Shows a board of forecasts.', installed: false, compatible: true, marketplace: 'bb-community' },
        { entryId: 'impeccable', pluginId: 'impeccable', displayName: 'Impeccable', description: 'A kanban board, already installed.', installed: true, compatible: true, marketplace: 'bb-community' },
      ];
      return store.filter(e => `${e.displayName} ${e.description}`.toLowerCase().includes(args[2].toLowerCase()));
    }
    throw new Error(`unexpected command: ${args.join(' ')}`);
  };
  return { cli, calls, capability: createCapabilities({ cli }) };
}
const ARGS = { projectId: 'proj_a', environmentId: 'env_a' };   // routed through the owning host
const LOCAL = { projectId: 'proj_a', environmentId: null };     // no environment: caller's own disk

test('capability tools are read-only, bounded, and reject unknown or malformed arguments', async () => {
  const base = await workspace();
  const { capability, calls } = bb(base);
  await assert.rejects(capability('bb_install_plugin', {}), /Unknown BB capability tool/);
  for (const [name, args] of [
    ['bb_capabilities', { projectId: 'proj_a', environmentId: 'env_a', kind: 'everything' }],
    ['bb_capabilities', { projectId: '../etc', environmentId: null, kind: 'all' }],
    ['bb_find_capability', { ...ARGS, query: 'x', includePluginCatalog: false }],
    ['bb_read_capability', { ...ARGS, name: '../../etc/passwd', extra: 1 }],
  ]) await assert.rejects(capability(name, args));
  assert.equal(calls.length, 0, 'no CLI process runs before validation');
  // Every advertised command is a read. Nothing installs, enables, writes or spawns.
  await capability('bb_find_capability', { ...ARGS, query: 'diagnosis screen', includePluginCatalog: true });
  const verbs = calls.map(a => a.slice(0, 2).join(' '));
  assert.deepEqual([...new Set(verbs)].sort(), ['environment show', 'machine list', 'plugin list', 'plugin search',
    'project content', 'project files', 'project paths', 'project show', 'skill list']);
  for (const args of calls) assert.ok(!args.some(a => /^(install|enable|disable|remove|spawn|tell|stop|update|delete)$/.test(a)), args.join(' '));
});

test('canonical repo skills are found although BB never indexed them, with the exact path a worker needs', async () => {
  const base = await workspace();
  const { capability } = bb(base);
  const found = await capability('bb_find_capability', { ...ARGS, query: 'diagnose approval card', includePluginCatalog: false });
  const top = found.matches[0];
  assert.equal(top.name, 'il-diagnosis-one-screen');
  assert.equal(top.availability, 'present-not-indexed');
  assert.equal(top.autoDiscovered, false);
  assert.equal(top.relativePath, 'skills/il-diagnosis-one-screen/SKILL.md');
  assert.equal(top.requirements.invocation, 'Skill(il-diagnosis-one-screen)');
  assert.equal(top.requirements.absolutePath, null, 'a file read on the owning host has no path here');
  assert.equal(top.requirements.pathIsWorkspaceRelative, true);
  assert.equal(found.coverage.discovery, 'workspace-api');
  // The same lookup with no environment reads this machine, and then an absolute path is real.
  const local = await capability('bb_find_capability', { ...LOCAL, query: 'diagnose approval card', includePluginCatalog: false });
  assert.equal(local.coverage.discovery, 'local-filesystem');
  assert.equal(local.matches[0].requirements.absolutePath, join(base, 'skills/il-diagnosis-one-screen/SKILL.md'));
  assert.equal(top.requirements.projectId, 'proj_a');
  assert.equal(top.requirements.environmentId, 'env_a');
  assert.equal(top.requirements.hostName, 'build-server');
  assert.match(top.requirements.briefLine, /skills\/il-diagnosis-one-screen\/SKILL\.md/);
  assert.match(top.note, /will not find it on its own/);
  // A reusable skill outranks the project command that merely mentions diagnosis.
  assert.ok(found.matches.findIndex(m => m.name === 'il-diagnosis-one-screen')
    < found.matches.findIndex(m => m.name === 'diagnosis-flow'));
});

test('installed, unindexed, other-host and plugin-disabled availability stay distinct', async () => {
  const base = await workspace();
  const { capability } = bb(base);
  const roster = await capability('bb_capabilities', { ...ARGS, kind: 'skills' });
  const by = name => roster.skills.find(s => s.name === name);
  assert.equal(by('key-behavior').availability, 'installed');
  assert.equal(by('key-behavior').autoDiscovered, undefined, 'terse roster omits the flag when it is auto-discovered');
  assert.equal(by('il-diagnosis-one-screen').availability, 'present-not-indexed');
  assert.equal(by('impeccable').availability, 'installed');
  assert.equal(by('offline-only').availability, 'plugin-disabled');
  assert.deepEqual(roster.coverage.unreachableHosts, ['the-mac']);
  assert.ok(roster.coverage.checkedRoots.some(r => r.host === 'the-mac' && r.state === 'other-host'));
  assert.ok(roster.notAutoDiscovered.some(s => s.relativePath === 'skills/il-diagnosis-one-screen/SKILL.md'));
});

test('a workspace on another machine is enumerated through its owning host, never from a local mirror', async () => {
  // The decisive case: the target workspace lives on another machine AND an identical mirror
  // sits at the same path on this one. This repo is mirrored between hosts, so a local read
  // would look correct and prove nothing. Only the owning host's answer is used.
  const mirror = await workspace();          // what the caller can see locally
  const owner = await workspace();           // what the owning host actually has
  await mkdir(join(owner, 'skills/only-on-the-owner'), { recursive: true });
  await writeFile(join(owner, 'skills/only-on-the-owner/SKILL.md'),
    '---\nname: only-on-the-owner\ndescription: Present on the owning host and absent from the caller mirror.\n---\n\nBody.\n');
  await mkdir(join(mirror, 'skills/only-on-the-mirror'), { recursive: true });
  await writeFile(join(mirror, 'skills/only-on-the-mirror/SKILL.md'),
    '---\nname: only-on-the-mirror\ndescription: Present only on the caller and must never be reported.\n---\n\nBody.\n');
  const { capability } = bb(mirror, { remoteBase: owner });
  const roster = await capability('bb_capabilities', { ...ARGS, kind: 'skills' });
  assert.equal(roster.coverage.discovery, 'workspace-api');
  assert.ok(roster.skills.some(s => s.name === 'only-on-the-owner'), 'the owning host supplies the truth');
  assert.equal(roster.skills.find(s => s.name === 'only-on-the-mirror'), undefined,
    'a same-path local mirror is never accepted as evidence about the target');
  assert.ok(roster.coverage.checkedRoots.every(r => r.state !== 'scanned'), 'no local root is scanned in this mode');
  assert.match(roster.coverage.statement, /not from any local mirror/);
});

test('remote discovery still reaches the canonical skill and reads its required inputs', async () => {
  const mirror = await workspace();
  const owner = await workspace();
  const { capability } = bb(mirror, { remoteBase: owner });
  const found = await capability('bb_find_capability', { ...ARGS, query: 'diagnose approval card', includePluginCatalog: false });
  assert.equal(found.matches[0].name, 'il-diagnosis-one-screen');
  assert.equal(found.matches[0].availability, 'present-not-indexed');
  assert.equal(found.matches[0].relativePath, 'skills/il-diagnosis-one-screen/SKILL.md');
  assert.deepEqual(found.matches[0].requirements.requiredInputs,
    ['A screenshot of the screen under review', 'The user action the screen is meant to produce']);
  const detail = await capability('bb_read_capability', { ...ARGS, name: 'il-diagnosis-one-screen' });
  assert.match(detail.excerpt, /IL methodology for behavioral diagnosis/);
  assert.ok(detail.excerpt.length <= LIMITS.excerptChars);
  // A description BB's index dropped is recovered over the same path.
  const proof = await capability('bb_find_capability', { ...ARGS, query: 'proof point evidence research', includePluginCatalog: false });
  assert.match(proof.matches.find(m => m.name === 'proof-point').description, /Research evidence for a recommendation/);
});

test('a workspace path from BB is re-validated before use, and the .claude blind spot is declared', () => {
  const skills = { rel: 'skills', flat: false };
  const commands = { rel: '.opencode/commands', flat: true };
  assert.deepEqual(safeRemotePath('skills/il-bike-rack/SKILL.md', skills), { entry: 'il-bike-rack', path: 'skills/il-bike-rack/SKILL.md' });
  assert.deepEqual(safeRemotePath('.opencode/commands/ask.md', commands), { entry: 'ask', path: '.opencode/commands/ask.md' });
  for (const bad of [
    '../../etc/passwd/SKILL.md', 'skills/../../../SKILL.md', '/etc/skills/x/SKILL.md',
    'skills/x/y/SKILL.md', 'skills/x/NOTES.md', 'skills//SKILL.md', 'other/x/SKILL.md',
    'skills/.hidden/SKILL.md', 'skills/x/SKILL.md.bak', `skills/${'x'.repeat(400)}/SKILL.md`, '', null,
  ]) assert.equal(safeRemotePath(bad, skills), null, String(bad));
  assert.equal(safeRemotePath('skills/il-bike-rack/SKILL.md', commands), null, 'a path must match its own root');
});

test('when the owning host returns nothing, coverage says so instead of implying an empty project', async () => {
  const base = await workspace();
  const { capability } = bb(base, { fail: { 'project files': 'host unreachable', 'project paths': 'host unreachable' } });
  const roster = await capability('bb_capabilities', { ...ARGS, kind: 'skills' });
  assert.equal(roster.coverage.discovery, 'index-only');
  assert.equal(roster.coverage.scanned, false);
  assert.match(roster.coverage.statement, /CANNOT be detected here|Do not say the list is complete/);
  assert.equal(roster.totals.notIndexed, null, 'unmeasured, not zero — 0 would read as a finding');
  assert.equal(roster.skills.find(s => s.name === 'il-diagnosis-one-screen'), undefined);
  assert.ok(roster.skills.some(s => s.name === 'key-behavior'), 'indexed skills are still reported');
});

test('a repeated lookup in one voice session reuses the result instead of re-querying the host', async () => {
  const base = await workspace();
  const { capability, calls } = bb(base, { remoteBase: base });
  await capability('bb_capabilities', { ...ARGS, kind: 'skills' });
  const cold = calls.length;
  assert.ok(cold > 3);
  await capability('bb_find_capability', { ...ARGS, query: 'diagnose approval card', includePluginCatalog: false });
  await capability('bb_read_capability', { ...ARGS, name: 'il-diagnosis-one-screen' });
  const extra = calls.length - cold;
  assert.ok(extra <= 1, `warm lookups cost ${extra} calls`);
  // A different environment is a different workspace and must not reuse the first answer.
  await capability('bb_capabilities', { projectId: 'proj_a', environmentId: 'env_b', kind: 'skills' });
  assert.ok(calls.length - cold > 3, 'a different target is fetched, not served from cache');
});

test('provider copies of one skill collapse into one capability; a plugin skill stays separate', async () => {
  const base = await workspace();
  const { capability } = bb(base);
  const roster = await capability('bb_capabilities', { ...ARGS, kind: 'skills' });
  const key = roster.skills.filter(s => s.name === 'key-behavior');
  assert.equal(key.length, 1, 'two provider roots and two index rows are one capability');
  const full = await capability('bb_find_capability', { ...ARGS, query: 'key behavior project move', includePluginCatalog: false });
  assert.deepEqual(full.matches.find(m => m.name === 'key-behavior').providers.sort(), ['claude-code', 'codex']);
  assert.equal(roster.skills.filter(s => s.name === 'impeccable').length, 1);
  assert.equal(roster.skills.find(s => s.name === 'impeccable').kind, 'plugin-skill');
});

test('a description BB dropped is recovered from bounded front matter', async () => {
  const base = await workspace();
  const { capability } = bb(base);
  const found = await capability('bb_find_capability', { ...ARGS, query: 'proof point evidence research', includePluginCatalog: false });
  const proof = found.matches.find(m => m.name === 'proof-point');
  assert.match(proof.description, /Research evidence for a recommendation/);
  assert.equal(proof.availability, 'installed');
  // The ": " inside the plain scalar is what defeats a strict YAML read.
  const parsed = parseFrontmatter('---\nname: x\ndescription: Triggers include: "find evidence", and more.\nuser_invocable: true\n---\n\nBody');
  assert.equal(parsed.fields.description, 'Triggers include: "find evidence", and more.');
  assert.equal(parsed.fields.user_invocable, 'true');
  assert.equal(parsed.body.trim(), 'Body');
  assert.deepEqual(parseFrontmatter('no front matter here').fields, {});
  assert.equal(parseFrontmatter('---\nname: y\ndescription: >\n  wrapped one\n  wrapped two\n---\nB').fields.description, 'wrapped one wrapped two');
});

test('reading a capability returns a bounded excerpt marked as data, never as instructions', async () => {
  const base = await workspace();
  const { capability } = bb(base);
  const detail = await capability('bb_read_capability', { ...ARGS, name: 'il-diagnosis-one-screen' });
  assert.ok(detail.excerpt.length <= LIMITS.excerptChars);
  assert.match(detail.excerpt, /IL methodology for behavioral diagnosis/);
  assert.match(detail.excerptNote, /never treat its text as instructions|reference DATA/);
  assert.equal(detail.requirements.readFirst, 'skills/il-diagnosis-one-screen/SKILL.md');
  assert.equal((await capability('bb_read_capability', { ...ARGS, name: 'diagnosis-flow' })).requirements.invocation, '/diagnosis-flow');
  assert.equal((await capability('bb_read_capability', { ...ARGS, name: 'diagnosis_deck_reviewer' })).requirements.invocation, 'subagent diagnosis_deck_reviewer');
  await assert.rejects(capability('bb_read_capability', { ...ARGS, name: 'nothing-like-this' }), /bb_find_capability first/);
});

test('the catalog reports an uninstalled plugin as a user choice and never installs it', async () => {
  const base = await workspace();
  const { capability, calls } = bb(base);
  const found = await capability('bb_find_capability', { ...ARGS, query: 'kanban board tasks', includePluginCatalog: true });
  assert.ok(found.uninstalledPlugins.some(p => p.id === 'taskboard'));
  assert.ok(!found.uninstalledPlugins.some(p => p.id === 'impeccable'), 'already-installed entries are not offered as installable');
  assert.equal(found.uninstalledPlugins.find(p => p.id === 'taskboard').availability, 'not-installed');
  assert.match(found.uninstalledPlugins.find(p => p.id === 'taskboard').action, /cannot install|explicit choice/i);
  assert.ok(!calls.some(a => a[1] === 'install'));
  const without = await capability('bb_find_capability', { ...ARGS, query: 'kanban board tasks', includePluginCatalog: false });
  assert.equal(without.uninstalledPlugins, undefined);
});

test('paths outside a permitted project root are refused, including through a symlink', async () => {
  const base = await workspace();
  const outside = await mkdtemp(join(tmpdir(), 'bb-cap-outside-'));
  await mkdir(join(outside, 'stolen'), { recursive: true });
  await writeFile(join(outside, 'stolen/SKILL.md'), '---\nname: stolen\ndescription: secret\n---\n');
  await symlink(join(outside, 'stolen'), join(base, 'skills/escape'));
  for (const bad of ['..', '../../etc', 'a/b', '.ssh/../../root', '']) {
    await assert.rejects(safeChild(join(base, 'skills'), bad), /Unsafe capability path|escapes/);
  }
  await assert.rejects(safeChild(join(base, 'skills'), 'escape'), /escapes its project root/);
  // A link that stays inside the project is legitimate sharing and is followed.
  await symlink(join(base, 'skills/il-full-diagnosis'), join(base, '.claude/skills/linked-diagnosis'));
  assert.equal(await safeChild(join(base, '.claude/skills'), 'linked-diagnosis', [base]),
    join(base, '.claude/skills/linked-diagnosis'));
  const { capability } = bb(base);
  const roster = await capability('bb_capabilities', { ...LOCAL, kind: 'skills' });
  assert.equal(roster.skills.find(s => s.name === 'stolen'), undefined, 'a symlinked root escape is not indexed');
  assert.ok(roster.coverage.notes.some(n => /resolves outside this project/.test(n)));
  assert.ok(roster.skills.some(s => s.name === 'il-full-diagnosis'), 'the in-project link still yields its skill');
});

test('a failing BB index degrades to the on-disk scan and says so instead of reporting nothing', async () => {
  const base = await workspace();
  const { capability } = bb(base, { fail: { 'skill list': 'bb skill list exited 1' } });
  const roster = await capability('bb_capabilities', { ...LOCAL, kind: 'skills' });
  assert.match(roster.coverage.indexError, /exited 1/);
  assert.ok(roster.skills.some(s => s.name === 'il-diagnosis-one-screen'));
  assert.equal(roster.skills.find(s => s.name === 'key-behavior').availability, 'present-not-indexed');
  await assert.rejects(createCapabilities({ cli: async () => { throw new Error('bb unavailable'); } })('bb_capabilities', { ...ARGS, kind: 'all' }), /bb unavailable/);
});

test('responses stay inside their size budget while keeping a share of every category', async () => {
  const data = {
    skills: Array.from({ length: 300 }, (_, i) => ({ name: `skill-${i}`, description: 'x'.repeat(200) })),
    commands: Array.from({ length: 300 }, (_, i) => ({ name: `command-${i}`, description: 'y'.repeat(200) })),
    totals: { skills: 300, commands: 300 },
  };
  fitToBudget(data, ['commands', 'skills'], 5000);
  assert.ok(JSON.stringify(data).length <= 5000);
  assert.ok(data.commands.length > 0 && data.skills.length > 0, 'no category is drained while another is long');
  assert.ok(Math.abs(data.skills.length - data.commands.length) <= 1);
  assert.deepEqual(data.totals, { skills: 300, commands: 300 }, 'totals stay truthful after trimming');
  assert.match(data.trimNote, /trimmed/);
  const base = await workspace();
  const { capability } = bb(base);
  for (const kind of ['all', 'skills', 'commands', 'plugins']) {
    const size = JSON.stringify(await capability('bb_capabilities', { ...ARGS, kind })).length;
    assert.ok(size <= LIMITS.responseChars, `${kind} response was ${size}`);
  }
});

test('the ranker prefers a matching name and stays quiet on unrelated words', () => {
  const one = { name: 'il-diagnosis-one-screen', kind: 'skill', description: 'behavioral diagnosis of a single product screen' };
  const flow = { name: 'diagnosis-flow', kind: 'command', description: 'run the diagnosis pipeline' };
  const other = { name: 'pdf-compressor', kind: 'skill', description: 'shrink a pdf' };
  assert.ok(score('diagnose approval card', one) > score('diagnose approval card', flow));
  assert.equal(score('diagnose approval card', other), 0);
  assert.equal(score('', one), 0);
  assert.ok(score('screen diagnosis', one) > score('screen', one));
});

test('capability tools are exposed to the model with strict, closed JSON schemas', () => {
  const names = Object.keys(capabilitySchemas);
  for (const name of names) {
    const definition = toolDefinitions.find(t => t.name === name);
    assert.ok(definition, `${name} is not offered to the model`);
    assert.equal(definition.strict, true);
    assert.equal(definition.parameters.additionalProperties, false);
    assert.ok(definition.description.length > 80);
  }
  assert.match(toolDefinitions.find(t => t.name === 'bb_find_capability').description, /never installs/);
  assert.match(toolDefinitions.find(t => t.name === 'bb_read_capability').description, /DATA/);
});

test('a skill’s declared inputs reach the caller, so a brief cannot name a file it never attached', async () => {
  const base = await workspace();
  const { capability } = bb(base);
  const detail = await capability('bb_read_capability', { ...ARGS, name: 'il-diagnosis-one-screen' });
  assert.deepEqual(detail.requirements.requiredInputs, ['A screenshot of the screen under review', 'The user action the screen is meant to produce']);
  assert.match(detail.requirements.inputsNote, /naming a file is not the same as attaching it/);
  assert.deepEqual((await capability('bb_read_capability', { ...ARGS, name: 'key-behavior' })).requirements.requiredInputs, []);
  assert.equal((await capability('bb_read_capability', { ...ARGS, name: 'key-behavior' })).requirements.inputsNote, null);
  assert.deepEqual(requiredInputs('## Required Inputs\n\n- one\n- two\n\n## Next\n\n- three'), ['one', 'two']);
  assert.deepEqual(requiredInputs('no headings at all'), []);
  assert.equal(requiredInputs(`## Inputs\n${'- x\n'.repeat(40)}`).length, 6, 'bounded');
});

test('a spoken phrase still reaches the plugin store, which only matches literally', async () => {
  const base = await workspace();
  const { capability, calls } = bb(base);
  const found = await capability('bb_find_capability', { ...ARGS, query: 'kanban board for tasks', includePluginCatalog: true });
  const probes = calls.filter(a => a[1] === 'search').map(a => a[2]);
  assert.ok(probes.length > 1 && probes.length <= LIMITS.catalogProbes, `probed terms, not the phrase: ${probes}`);
  assert.ok(!probes.includes('kanban board for tasks'), 'the raw phrase would match nothing');
  assert.ok(probes.every(p => !p.startsWith('-')), 'a term can never become a CLI flag');
  assert.ok(found.uninstalledPlugins.some(p => p.id === 'taskboard'), 'the phrase now finds the store entry');
  // Deduplicated across probes.
  assert.equal(new Set(found.uninstalledPlugins.map(p => p.id)).size, found.uninstalledPlugins.length);
});

test('plugins are labelled installed-usable, installed-disabled, not-installed or incompatible, and never assumed callable', async () => {
  const base = await workspace();
  const { capability } = bb(base);
  const found = await capability('bb_find_capability', { ...ARGS, query: 'kanban board tasks', includePluginCatalog: true });
  const stale = found.uninstalledPlugins.find(p => p.id === 'oldboard');
  assert.equal(stale.availability, 'not-installed-incompatible');
  assert.equal(stale.compatible, false);
  assert.match(stale.incompatibleReason, /requires bb/);
  assert.match(stale.action, /do not propose installing/i);
  assert.equal(stale.reviewedByBb, false, 'a third-party marketplace entry is not BB-reviewed');
  assert.equal(found.uninstalledPlugins.find(p => p.id === 'taskboard').reviewedByBb, true);
  for (const p of found.uninstalledPlugins) assert.equal(p.callable, false);
  // Installed plugins are searchable from the list already fetched, with usability distinguished.
  const design = await capability('bb_find_capability', { ...ARGS, query: 'impeccable frontend design', includePluginCatalog: false });
  assert.equal(design.installedPlugins.find(p => p.id === 'impeccable').availability, 'installed-usable');
  assert.equal(design.installedPlugins.find(p => p.id === 'impeccable').callable, true);
  const dormant = await capability('bb_find_capability', { ...ARGS, query: 'dormant disabled plugin', includePluginCatalog: false });
  const off = dormant.installedPlugins.find(p => p.id === 'dormant');
  assert.equal(off.availability, 'installed-disabled');
  assert.equal(off.callable, false);
  assert.match(off.note, /contributes nothing until the user enables it/);
});

test('a native project skill stays the first preference and weak plugin matches are dropped', async () => {
  const base = await workspace();
  const { capability, calls } = bb(base);
  const found = await capability('bb_find_capability', { ...ARGS, query: 'diagnose approval card', includePluginCatalog: true });
  assert.equal(found.matches[0].name, 'il-diagnosis-one-screen');
  assert.match(found.preference, /Prefer a native project skill/);
  assert.match(found.preference, /never assume it can be used/);
  assert.deepEqual(found.installedPlugins, [], 'no plugin is dragged in by an unrelated query');
  assert.deepEqual(found.uninstalledPlugins, [], 'the store contributes nothing to an unrelated query');
  // The store is only consulted on demand.
  const quiet = await capability('bb_find_capability', { ...ARGS, query: 'kanban board tasks', includePluginCatalog: false });
  assert.equal(quiet.uninstalledPlugins, undefined);
  assert.equal(calls.filter(a => a[1] === 'search').length, LIMITS.catalogProbes > 0 ? calls.filter(a => a[1] === 'search').length : 0);
  const { capability: fresh, calls: quietCalls } = bb(base);
  await fresh('bb_find_capability', { ...ARGS, query: 'kanban board tasks', includePluginCatalog: false });
  assert.equal(quietCalls.filter(a => a[1] === 'search').length, 0, 'no store call without an explicit request');
  assert.ok(!quietCalls.some(a => /^(install|enable|disable|remove)$/.test(a[1])));
});

test('an unenumerated host cannot be reported as a measured fact', async () => {
  const base = await workspace();
  const { capability } = bb(base, { fail: { 'project files': 'unreachable', 'project paths': 'unreachable' } });
  const roster = await capability('bb_capabilities', { ...ARGS, kind: 'skills' });
  // The contradiction to prevent: a confident roster sitting next to coverage.scanned === false.
  assert.equal(roster.coverage.scanned, false);
  assert.equal(roster.totals.notIndexed, null, 'nothing was enumerated, so "none unindexed" was never measured');
  assert.notEqual(roster.totals.notIndexed, 0);
  assert.match(roster.totals.basis, /index ONLY|not enumerated/i, 'the caveat travels with the numbers');
  assert.match(roster.coverage.spokenCaveat, /never "it has N"/);
  assert.ok(roster.skills.length > 0, 'indexed skills are still reported — the index is real evidence');
  for (const skill of roster.skills) assert.equal(skill.evidence, 'bb-index', skill.name);
  // And when the host IS enumerated, the caveat disappears and evidence upgrades.
  const good = bb(base, { remoteBase: base });
  const full = await good.capability('bb_capabilities', { ...ARGS, kind: 'skills' });
  assert.equal(full.coverage.spokenCaveat, null);
  assert.equal(typeof full.totals.notIndexed, 'number');
  assert.ok(full.skills.some(s => s.evidence === 'workspace-api'));
});

test('the declared source names what actually contributed, not what might have', async () => {
  const base = await workspace();
  const reader = mode => createReader({ cliPath: '/bb', serverUrl: 'http://local',
    run: async (path, args) => ({ stdout: JSON.stringify(await mode(args)) }) });
  const full = bb(base, { remoteBase: base });
  const degraded = bb(base, { fail: { 'project files': 'x', 'project paths': 'x' } });
  const local = bb(base);
  const source = async (fixture, args) => (await reader(fixture.cli)('bb_capabilities', args)).source;
  assert.match(await source(full, { ...ARGS, kind: 'skills' }), /owning host/);
  assert.match(await source(degraded, { ...ARGS, kind: 'skills' }), /index only|not enumerated/i);
  assert.match(await source(local, { ...LOCAL, kind: 'skills' }), /on this machine/);
});

test('an unreachable host never produces a confident "it does not exist"', async () => {
  const base = await workspace();
  const { capability } = bb(base, { fail: { 'project files': 'unreachable', 'project paths': 'unreachable' } });
  // The skill is real and on disk, but the host could not be enumerated. Answering "no" here,
  // or answering with unrelated fuzzy matches and no caveat, is the failure to prevent.
  const found = await capability('bb_find_capability', { ...ARGS, query: 'il-diagnosis-one-screen', includePluginCatalog: false });
  assert.equal(found.matches.some(m => m.name === 'il-diagnosis-one-screen'), false, 'precondition: the index cannot see it');
  assert.match(found.unscannedHost, /Do not tell the user it does not exist/);
  assert.match(found.unscannedHost, /WILL be missing from this list/);
  for (const match of found.matches) assert.equal(match.searchedHost, false, `${match.name} must not look host-verified`);
  await assert.rejects(capability('bb_read_capability', { ...ARGS, name: 'il-diagnosis-one-screen' }),
    /NOT a finding that the capability is absent|could not reach that host/);
  const empty = await capability('bb_find_capability', { ...ARGS, query: 'zzzz nothing like this exists', includePluginCatalog: false });
  assert.match(empty.statement, /NOT evidence that no such capability exists/);
  // When the host IS reachable the warning disappears and the skill is found.
  const good = bb(base, { remoteBase: base });
  const ok = await good.capability('bb_find_capability', { ...ARGS, query: 'il-diagnosis-one-screen', includePluginCatalog: false });
  assert.equal(ok.unscannedHost, undefined);
  assert.ok(ok.matches.some(m => m.name === 'il-diagnosis-one-screen'));
  assert.ok(ok.matches.every(m => m.searchedHost === undefined));
});

test('a host that answers nothing at all reports zero as unmeasured, not as "there are none"', async () => {
  const base = await workspace();
  // The disconnected-host case: the workspace API fails AND the skill index errors. A confident
  // zero is a stronger false claim than an inflated count, so it must not read as a count.
  const { capability } = bb(base, { fail: {
    'project files': 'HTTP 502: Host unreachable', 'project paths': 'HTTP 502: Host unreachable',
    'skill list': 'HTTP 502: Host unreachable' } });
  const roster = await capability('bb_capabilities', { ...ARGS, kind: 'skills' });
  assert.equal(roster.coverage.discovery, 'unavailable', 'not "index-only" — the index did not answer either');
  assert.equal(roster.totals.skills, 0);
  assert.equal(roster.totals.notIndexed, null);
  assert.match(roster.totals.basis, /absence of a measurement, not a count/);
  assert.match(roster.totals.basis, /Never say the project has no skills there/);
  assert.match(roster.coverage.spokenCaveat, /A zero here is NOT a finding/);
  assert.match(roster.coverage.statement, /nothing was readable, NOT because the project has nothing/);
  const found = await capability('bb_find_capability', { ...ARGS, query: 'diagnose approval card', includePluginCatalog: false });
  assert.deepEqual(found.matches, []);
  assert.match(found.statement, /NOT evidence that no such capability exists/);
  assert.ok(found.unscannedHost);
});

test('evidence travels with every shape the model sees, not just the roster', async () => {
  const base = await workspace();
  const { capability } = bb(base, { remoteBase: base });
  const roster = await capability('bb_capabilities', { ...ARGS, kind: 'skills' });
  for (const skill of roster.skills) assert.ok(skill.evidence, `roster entry ${skill.name} lacks evidence`);
  const found = await capability('bb_find_capability', { ...ARGS, query: 'diagnose approval card', includePluginCatalog: false });
  for (const match of found.matches) assert.ok(match.evidence, `match ${match.name} lacks evidence`);
  const detail = await capability('bb_read_capability', { ...ARGS, name: 'il-diagnosis-one-screen' });
  assert.ok(detail.capability.evidence, 'read result lacks evidence');
  assert.equal(detail.capability.evidence, 'workspace-api');
});

// The unscannedHost field is only worth having if the model is told to say it. An absent
// capability on a host nobody could read is not evidence the capability does not exist.
test('the unscanned-host caveat is both emitted and instructed', async () => {
  const { backendInstructions } = await import('../live-session.mjs');
  const text = backendInstructions({ threadId: null, projectId: null });
  assert.match(text, /if unscannedHost is present/);
  assert.match(text, /never answer "there is no skill for that" from an unscanned host/);
  assert.match(text, /treat notIndexed:null as "not measured", never as "none"/);
  const source = await readFile(new URL('../bb-capabilities.mjs', import.meta.url), 'utf8');
  assert.match(source, /data\.unscannedHost = /);
  assert.match(source, /Do not tell the user it does not exist; say you could not check that host\./);
});
