// Created: 2026-09-15. Read-only integration example for capability discovery.
// Runs the real BB CLI. No voice session, no paid call, no writes, no installs.
//   node probe-capabilities.mjs <proj_id> [env_id] ["search query"]
import { createCli } from './bb-read.mjs';
import { createCapabilities } from './bb-capabilities.mjs';

const [projectId, environmentId = null, query = 'diagnose approval card'] = process.argv.slice(2);
if (!projectId) { console.error('Usage: node probe-capabilities.mjs <proj_id> [env_id] ["query"]'); process.exit(2); }

const cli = createCli({ cliPath: process.env.BB_CLI || 'bb', serverUrl: process.env.BB_SERVER_URL || '', timeout: 60000 });
const capability = createCapabilities({ cli });

const roster = await capability('bb_capabilities', { projectId, environmentId, kind: 'all' });
console.log(`project ${roster.project.name} · env ${roster.environment?.id ?? 'none'} (${roster.environment?.hostName ?? '-'})`);
console.log('totals', roster.totals);
for (const root of roster.coverage.checkedRoots) console.log(`  root ${root.rel.padEnd(18)} ${String(root.state).padEnd(12)} ${root.entries} @ ${root.host}`);
if (roster.coverage.unreachableHosts.length) console.log('  unreachable hosts:', roster.coverage.unreachableHosts.join(', '));
console.log('  index error:', roster.coverage.indexError ?? 'none');

const found = await capability('bb_find_capability', { projectId, environmentId, query, includePluginCatalog: true });
console.log(`\nsearch "${query}" over ${found.searched} capabilities:`);
for (const m of found.matches) {
  console.log(`  ${String(m.relevance).padStart(5)}  ${m.name.padEnd(30)} ${m.availability.padEnd(20)} ${m.relativePath ?? ''}`);
  console.log(`         brief line: ${m.requirements.briefLine}`);
}
for (const p of found.uninstalledPlugins ?? []) console.log(`  catalog (NOT installed): ${p.name} — ${p.action}`);

const top = found.matches[0];
if (top) {
  const detail = await capability('bb_read_capability', { projectId, environmentId, name: top.name });
  console.log(`\nread ${detail.capability.name}: ${detail.excerpt ? `${detail.excerpt.length} chars` : 'unreadable'}, truncated=${detail.excerptTruncated}`);
  console.log('requirements', JSON.stringify(detail.requirements, null, 1));
}
