// Created: 2026-09-26.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cliCommand, createCli } from '../bb-read.mjs';

const withDir = async fn => { const dir = mkdtempSync(join(tmpdir(), 'bb-cli-')); try { return await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); } };
const script = (dir, name, first, body = 'console.log(JSON.stringify({ argv: process.argv.slice(2) }));') => {
  const file = join(dir, name); writeFileSync(file, `${first}\n${body}\n`); chmodSync(file, 0o755); return file;
};

test('a JavaScript CLI runs under this process\'s node', () => withDir(dir => {
  const file = join(dir, 'bb.mjs');
  assert.deepEqual(cliCommand(file, ['thread', 'list']), [process.execPath, [file, 'thread', 'list']]);
}));

test('an extensionless CLI whose shebang is env node runs under this process\'s node', () => withDir(dir => {
  for (const shebang of ['#!/usr/bin/env node', '#! /usr/bin/env -S node --no-warnings']) {
    const file = script(dir, 'bb', shebang);
    assert.deepEqual(cliCommand(file, ['status']), [process.execPath, [file, 'status']]);
  }
}));

test('native executables, other interpreters, bare names and missing files are run as-is', () => withDir(dir => {
  for (const file of [script(dir, 'sh-cli', '#!/bin/sh'), script(dir, 'py-cli', '#!/usr/bin/env python3'), script(dir, 'abs-node', '#!/usr/bin/node'),
    join(dir, 'missing'), 'bb', '/bin/ls']) {
    assert.deepEqual(cliCommand(file, ['status']), [file, ['status']]);
  }
}));

test('a bb CLI with an env-node shebang works when PATH has no node', () => withDir(async dir => {
  const file = script(dir, 'bb', '#!/usr/bin/env node');
  const saved = process.env.PATH;
  process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
  try {
    assert.deepEqual(await createCli({ cliPath: file, serverUrl: 'http://local' })(['project', 'list']), { argv: ['project', 'list'] });
  } finally { process.env.PATH = saved; }
}));
