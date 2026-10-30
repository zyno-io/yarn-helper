import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import { configureRegistry, ensureCorepack, findProject } from '../src/bootstrap.mjs';
import { main, parseArgs } from '../src/index.mjs';

test('selects the workspace owner from a nested directory, including a checked packageManager', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yarn-helper-project-'));
  try {
    await mkdir(join(root, 'packages/api/src'), { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify({ packageManager: 'yarn@4.18.1+sha224.example', workspaces: ['packages/*'] }));
    await writeFile(join(root, 'packages/api/package.json'), '{"name":"api"}');
    const project = await findProject(join(root, 'packages/api/src'));
    assert.equal(project.root, root);
    assert.equal(project.manager, 'yarn@4.18.1+sha224.example');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('keeps a nested project with its own package manager independent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yarn-helper-project-'));
  try {
    await mkdir(join(root, 'child'));
    await writeFile(join(root, 'package.json'), '{"packageManager":"yarn@4.18.1"}');
    await writeFile(join(root, 'child/package.json'), '{"packageManager":"npm@12.2.1"}');
    const project = await findProject(join(root, 'child'));
    assert.equal(project.manager, 'npm@12.2.1');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('merges scoped auth references without writing the token, losing config or changing mode', async () => {
  const home = await mkdtemp(join(tmpdir(), 'yarn-helper-auth-'));
  try {
    const file = join(home, '.yarnrc.yml');
    await writeFile(file, '# keep this comment\nnodeLinker: pnp\nnpmScopes:\n  example:\n    npmRegistryServer: https://registry.example/\nnpmRegistries:\n  "https://npm.s24.dev/":\n    npmAuthIdent: untouched\n', { mode: 0o600 });
    const env = { HOME: home, PRIVATE_NPM_TOKEN: 'test-secret-do-not-persist' };
    const result = await configureRegistry({ env, home });
    const source = await readFile(file, 'utf8');
    const value = parse(source);
    assert.equal(result.PRIVATE_NPM_TOKEN, env.PRIVATE_NPM_TOKEN);
    assert.ok(!source.includes(env.PRIVATE_NPM_TOKEN));
    assert.match(source, /keep this comment/);
    assert.equal(value.nodeLinker, 'pnp');
    assert.equal(value.npmScopes.example.npmRegistryServer, 'https://registry.example/');
    assert.deepEqual(Object.keys(value.npmRegistries), ['https://npm.s24.dev/']);
    assert.equal(value.npmRegistries['https://npm.s24.dev/'].npmAuthIdent, 'untouched');
    assert.equal(value.npmRegistries['https://npm.s24.dev/'].npmAuthToken, '${PRIVATE_NPM_TOKEN:-}');
    const before = await stat(file);
    await configureRegistry({ env, home });
    const after = await stat(file);
    const repeated = await readFile(file, 'utf8');
    assert.equal(repeated, source);
    assert.equal(after.mtimeMs, before.mtimeMs);
    if (process.platform !== 'win32') assert.equal(after.mode & 0o777, 0o600);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('reads mounted secrets into the child environment only', async () => {
  const home = await mkdtemp(join(tmpdir(), 'yarn-helper-secret-'));
  try {
    const tokenFile = join(home, 'token');
    await writeFile(tokenFile, 'mounted-secret\n');
    const env = await configureRegistry({ env: {}, tokenFile, home });
    const source = await readFile(join(home, '.yarnrc.yml'), 'utf8');
    assert.equal(env.PRIVATE_NPM_TOKEN, 'mounted-secret');
    assert.ok(!source.includes('mounted-secret'));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('missing credentials leave the configuration byte for byte intact', async () => {
  const home = await mkdtemp(join(tmpdir(), 'yarn-helper-no-auth-'));
  try {
    const file = join(home, '.yarnrc.yml');
    const source = '# unchanged\nnodeLinker: node-modules\n';
    await writeFile(file, source);
    await configureRegistry({ env: {}, home });
    const after = await readFile(file, 'utf8');
    assert.equal(after, source);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('rejects invalid existing YAML without overwriting it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'yarn-helper-bad-config-'));
  try {
    const file = join(home, '.yarnrc.yml');
    const source = 'npmRegistries: [unterminated';
    await writeFile(file, source);
    await assert.rejects(configureRegistry({ env: { PRIVATE_NPM_TOKEN: 'secret' }, home }), /Cannot update/);
    const after = await readFile(file, 'utf8');
    assert.equal(after, source);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('updating a symlinked config preserves its symlink', { skip: process.platform === 'win32' }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'yarn-helper-symlink-'));
  try {
    const target = join(home, 'real.yml');
    await writeFile(target, 'nodeLinker: pnp\n');
    await symlink(target, join(home, '.yarnrc.yml'));
    await configureRegistry({ env: { PRIVATE_NPM_TOKEN: 'secret' }, home });
    const source = await readFile(target, 'utf8');
    const value = parse(source);
    assert.equal(value.nodeLinker, 'pnp');
    const { lstat } = await import('node:fs/promises');
    const info = await lstat(join(home, '.yarnrc.yml'));
    assert.equal(info.isSymbolicLink(), true);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('installs Corepack in the chosen prefix and enables persistent Yarn shims', async () => {
  const prefix = await mkdtemp(join(tmpdir(), 'yarn-helper-corepack-'));
  const calls = [];
  try {
    const path = join(prefix, process.platform === 'win32' ? 'node_modules' : 'lib/node_modules', 'corepack/dist/corepack.js');
    const result = await ensureCorepack({ env: process.env, cwd: prefix, prefix, stderr: { write() {} }, run: async (args, options) => {
      calls.push({ args, options });
      if (args.includes('install')) { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, ''); }
      return { code: 0 };
    } });
    assert.equal(calls.length, 2);
    assert.ok(calls[0].args.includes('corepack@^0.36.0'));
    assert.ok(calls[0].args.includes('https://registry.npmjs.org/'));
    assert.deepEqual(calls[1].args, [path, 'enable', 'yarn', '--install-directory', result.binDirectory]);
    await ensureCorepack({ env: process.env, cwd: prefix, prefix, stderr: { write() {} }, run: async args => { calls.push({ args }); return { code: 0 }; } });
    assert.equal(calls.length, 3, 'an existing Corepack must not be reinstalled');
  } finally { await rm(prefix, { recursive: true, force: true }); }
});

test('a Corepack installation failure is not treated as a ready setup', async () => {
  const prefix = await mkdtemp(join(tmpdir(), 'yarn-helper-bad-corepack-'));
  try {
    await assert.rejects(ensureCorepack({ env: process.env, cwd: prefix, prefix, stderr: { write() {} }, run: async () => ({ code: 12, errorOutput: 'npm failure' }) }), /Corepack installation failed \(12\)/);
  } finally { await rm(prefix, { recursive: true, force: true }); }
});

test('parses helper options only before the Yarn command and preserves every Yarn argument', () => {
  const parsed = parseArgs(['--npm-token-file', '/run/secrets/npm_token', 'install', '--immutable', '--help']);
  assert.deepEqual(parsed, { options: { tokenFile: '/run/secrets/npm_token' }, yarnArgs: ['install', '--immutable', '--help'] });
  assert.deepEqual(parseArgs(['--', '--version']).yarnArgs, ['--version']);
  assert.throws(() => parseArgs(['--npm-token-file']), /requires a value/);
});

test('help does not bootstrap tools, write config or require a project', async () => {
  let output = '';
  const code = await main(['--help'], { env: {}, cwd: '/', stdout: { write: chunk => { output += chunk; } } });
  assert.equal(code, 0);
  assert.match(output, /install --immutable/);
});
