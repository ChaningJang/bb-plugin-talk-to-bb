// Created: 2026-09-15. Deterministic read-only check that capability discovery works when the
// target workspace lives on a DIFFERENT machine than the caller. No model API, no voice
// session, no writes, no installs. Exits 0 on pass, 1 on failure.
//   node probe-remote-discovery.mjs <proj_id> <env_id> [expected-skill] [expected-path]
import { createCli } from './bb-read.mjs';
import { createCapabilities } from './bb-capabilities.mjs';

const [projectId, environmentId,
  skill = 'il-diagnosis-one-screen',
  relativePath = 'skills/il-diagnosis-one-screen/SKILL.md'] = process.argv.slice(2);
if (!projectId || !environmentId) {
  console.error('Usage: node probe-remote-discovery.mjs <proj_id> <env_id> [skill] [path]');
  process.exit(2);
}

const cli = createCli({ cliPath: process.env.BB_CLI || 'bb', serverUrl: process.env.BB_SERVER_URL || '', timeout: 120000 });
const capability = createCapabilities({ cli });
const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok: Boolean(ok), detail }); };

const started = Date.now();
const env = await cli(['environment', 'show', environmentId, '--json']);
const machines = await cli(['machine', 'list', '--json']).catch(() => []);
const host = (Array.isArray(machines) ? machines : machines.machines ?? []).find(m => m.id === env.hostId);
console.log(`caller: ${process.platform} · target environment ${environmentId} on ${host?.name ?? env.hostId} (${env.path})`);

const roster = await capability('bb_capabilities', { projectId, environmentId, kind: 'skills' });
check('discovery routed through the owning host', roster.coverage.discovery === 'workspace-api', roster.coverage.discovery);
check('no local root was scanned', roster.coverage.checkedRoots.every(r => r.state !== 'scanned'));
check('unindexed skills were detected', roster.totals.notIndexed > 0, `notIndexed=${roster.totals.notIndexed}`);
check(`${skill} listed as not auto-discovered`, roster.notAutoDiscovered.some(s => s.name === skill && s.relativePath === relativePath));

const found = await capability('bb_find_capability', { projectId, environmentId, query: 'diagnose approval card', includePluginCatalog: false });
const top = found.matches[0];
check(`search ranks ${skill} first`, top?.name === skill, top?.name);
check('availability is present-not-indexed', top?.availability === 'present-not-indexed', top?.availability);
check('exact workspace path supplied', top?.relativePath === relativePath, top?.relativePath);
check('no absolute path is claimed for another machine', top?.requirements.absolutePath === null);
check('brief line names the file', /SKILL\.md/.test(top?.requirements.briefLine ?? ''), top?.requirements.briefLine);

const detail = await capability('bb_read_capability', { projectId, environmentId, name: skill });
check('required inputs were read', detail.requirements.requiredInputs.length > 0, JSON.stringify(detail.requirements.requiredInputs));
check('an image input is declared', detail.requirements.requiredInputs.some(i => /screenshot|image/i.test(i)));
check('excerpt was read from the owning host', (detail.excerpt?.length ?? 0) > 500, `${detail.excerpt?.length ?? 0} chars`);

for (const c of checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
const failed = checks.filter(c => !c.ok);
console.log(`\n${failed.length ? `FAILED ${failed.length}/${checks.length}` : `PASSED ${checks.length}/${checks.length}`} in ${Date.now() - started}ms`);
process.exit(failed.length ? 1 : 0);
