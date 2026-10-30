import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const temporary = await mkdtemp(join(tmpdir(), 'yarn-helper-smoke-'));
const root = await realpath(temporary);
const project = join(root, 'project');
const home = join(root, 'home');
const prefix = join(root, 'corepack');
const secret = 'fixture-token-never-persist';
const npmCli = process.env.npm_execpath;
assert.ok(npmCli?.endsWith('npm-cli.js'), 'Run the smoke test using npm run test:smoke');
const env = {
  ...process.env, HOME: home, USERPROFILE: home, COREPACK_HOME: join(root, 'corepack-cache'),
  NPM_CONFIG_CACHE: join(root, 'npm-cache'), NPM_CONFIG_USERCONFIG: join(root, 'npmrc'),
  PATH: `${process.platform === 'win32' ? prefix : join(prefix, 'bin')}${delimiter}${dirname(process.execPath)}${delimiter}${process.env.PATH}`,
  CI: 'true'
};
for (const key of ['PRIVATE_NPM_TOKEN', 'YARN_NPM_AUTH_TOKEN', 'NODE_AUTH_TOKEN', 'NPM_TOKEN']) delete env[key];
const requests = [];

async function registry(name, privateRegistry) {
  const packageDirectory = join(root, privateRegistry ? 'private-package' : 'public-package');
  await mkdir(packageDirectory);
  await writeFile(join(packageDirectory, 'package.json'), JSON.stringify({ name, version: '1.0.0', main: 'index.js' }));
  await writeFile(join(packageDirectory, 'index.js'), 'module.exports = 1;\n');
  const packed = await execute(process.execPath, [npmCli, 'pack', packageDirectory, '--ignore-scripts', '--json', '--pack-destination', root], { env });
  const filename = JSON.parse(packed.stdout)[0].filename;
  const tarball = await readFile(join(root, filename));
  const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
  const server = createServer((request, response) => {
    requests.push({ privateRegistry, authorization: request.headers.authorization });
    if (privateRegistry && request.headers.authorization !== `Bearer ${secret}`) {
      response.writeHead(401); response.end('authentication required'); return;
    }
    if (request.url.startsWith('/-/')) { response.end(tarball); return; }
    const address = server.address();
    const dist = { tarball: `http://127.0.0.1:${address.port}/-/${filename}`, integrity };
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ name, 'dist-tags': { latest: '1.0.0' }, time: { '1.0.0': '2020-01-01T00:00:00.000Z' }, versions: { '1.0.0': { name, version: '1.0.0', dist } } }));
  });
  await new Promise(resolveListening => server.listen(0, '127.0.0.1', resolveListening));
  const address = server.address();
  return { server, url: `http://127.0.0.1:${address.port}` };
}

let publicRegistry;
let privateRegistry;
try {
  await mkdir(project);
  await mkdir(home);
  await writeFile(env.NPM_CONFIG_USERCONFIG, 'registry=https://registry.npmjs.org/\n');
  publicRegistry = await registry('public-fixture', false);
  privateRegistry = await registry('@example/private-fixture', true);
  const manifest = `${JSON.stringify({
    name: 'yarn-helper-fixture', private: true, packageManager: 'yarn@4.18.1',
    dependencies: { '@example/private-fixture': '1.0.0', 'public-fixture': '1.0.0' },
    scripts: { postinstall: 'node -e "require(\'node:fs\').writeFileSync(\'postinstall.marker\', \'done\')"' }
  }, null, 2)}\n`;
  await writeFile(join(project, 'package.json'), manifest);
  await writeFile(join(project, '.yarnrc.yml'), `nodeLinker: node-modules\nenableGlobalCache: false\nunsafeHttpWhitelist: [127.0.0.1]\nnpmRegistryServer: ${publicRegistry.url}\nnpmScopes:\n  example:\n    npmRegistryServer: ${privateRegistry.url}\n    npmAlwaysAuth: true\n`);
  const tokenFile = join(root, 'npm-token');
  await writeFile(tokenFile, secret, { mode: 0o600 });
  const cli = fileURLToPath(new URL('../bin/yarn-helper.mjs', import.meta.url));
  const packaged = process.env.HELPER_SMOKE_PACKAGE;
  const command = packaged ? [npmCli, 'exec', '--yes', '--registry=https://registry.npmjs.org/', '--package', resolve(packaged), '--', 'yarn-helper'] : [cli];
  const options = ['--corepack-prefix', prefix, '--npm-registry', privateRegistry.url, '--npm-token-file', tokenFile];
  const run = async args => {
    const result = await execute(process.execPath, [...command, ...options, ...args], { cwd: project, env, maxBuffer: 8 * 1024 * 1024, timeout: 120_000 });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
  };
  await run(['setup']);
  const shim = process.platform === 'win32' ? join(prefix, 'yarn.cmd') : join(prefix, 'bin/yarn');
  await stat(shim);
  const version = process.platform === 'win32'
    ? await execute('cmd.exe', ['/d', '/s', '/c', 'yarn --version'], { cwd: project, env })
    : await execute('yarn', ['--version'], { cwd: project, env });
  assert.equal(version.stdout.trim(), '4.18.1');
  await run(['install', '--no-immutable']);
  const lockfile = await readFile(join(project, 'yarn.lock'));
  const marker = await readFile(join(project, 'postinstall.marker'), 'utf8');
  assert.equal(marker, 'done', 'ordinary workspace postinstall hooks must execute');
  await rm(join(project, 'node_modules'), { recursive: true });
  await rm(join(project, '.yarn/install-state.gz'), { force: true });
  await rm(join(project, 'postinstall.marker'));
  await run(['install', '--immutable']);
  const installedManifest = await readFile(join(project, 'package.json'), 'utf8');
  const installedLockfile = await readFile(join(project, 'yarn.lock'));
  const repeatedMarker = await readFile(join(project, 'postinstall.marker'), 'utf8');
  assert.equal(installedManifest, manifest);
  assert.deepEqual(installedLockfile, lockfile);
  assert.equal(repeatedMarker, 'done');
  const config = await readFile(join(home, '.yarnrc.yml'), 'utf8');
  assert.ok(!config.includes(secret));
  assert.ok(requests.some(item => item.privateRegistry));
  assert.ok(requests.some(item => !item.privateRegistry));
  assert.ok(requests.filter(item => item.privateRegistry).every(item => item.authorization === `Bearer ${secret}`));
  assert.ok(requests.filter(item => !item.privateRegistry).every(item => item.authorization === undefined));
  console.log('Smoke passed: Corepack bootstrap, persistent Yarn shim, declared Yarn, scoped auth, immutable lockfile and lifecycle hooks.');
} finally {
  for (const registry of [publicRegistry, privateRegistry]) {
    if (registry) await new Promise(resolveClosed => registry.server.close(resolveClosed));
  }
  await rm(root, { recursive: true, force: true });
}
