import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { parseDocument } from 'yaml';

const COREPACK_SPEC = 'corepack@^0.36.0';
const PUBLIC_REGISTRY = 'https://registry.npmjs.org/';

async function exists(file) {
  try { await access(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export async function findProject(cwd) {
  let directory = resolve(cwd);
  while (true) {
    const file = join(directory, 'package.json');
    if (await exists(file)) {
      const source = await readFile(file, 'utf8');
      const manifest = JSON.parse(source);
      const manager = manifest.packageManager ?? manifest.devEngines?.packageManager?.name;
      if (manager) return { root: directory, manifest, manager };
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

export async function nodeBinDirectory(env = process.env) {
  const target = await realpath(process.execPath);
  for (const directory of (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)) {
    const file = join(directory, process.platform === 'win32' ? 'node.exe' : 'node');
    try {
      const candidate = await realpath(file);
      if (process.platform === 'win32' ? candidate.toLowerCase() === target.toLowerCase() : candidate === target) return resolve(directory);
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw error;
    }
  }
  return dirname(process.execPath);
}

async function npmCli(env, nodeBin) {
  const candidates = [
    env.npm_execpath,
    join(nodeBin, 'node_modules/npm/bin/npm-cli.js'),
    join(nodeBin, '../lib/node_modules/npm/bin/npm-cli.js')
  ].filter(Boolean);
  for (const directory of (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)) {
    candidates.push(join(directory, process.platform === 'win32' ? 'node_modules/npm/bin/npm-cli.js' : 'npm'));
  }
  for (const candidate of candidates) {
    if (await exists(candidate)) {
      const file = await realpath(candidate);
      if (basename(file) === 'npm-cli.js') return file;
      if (basename(file) === 'npx-cli.js') {
        const sibling = join(dirname(file), 'npm-cli.js');
        if (await exists(sibling)) return sibling;
      }
    }
  }
  throw new Error('Cannot locate npm. Run the helper through npx or install npm alongside Node.');
}

export async function command(args, { env, cwd, quiet = false, signal }) {
  return new Promise((resolveExit, reject) => {
    let errorOutput = '';
    const child = spawn(process.execPath, args, {
      env, cwd, signal, stdio: quiet ? ['ignore', 'ignore', 'pipe'] : 'inherit'
    });
    if (quiet) child.stderr.on('data', chunk => { errorOutput = (errorOutput + chunk).slice(-8192); });
    child.once('error', reject);
    child.once('close', (code, exitSignal) => resolveExit({ code: code ?? 1, signal: exitSignal, errorOutput }));
  });
}

export async function ensureCorepack({ env, cwd, prefix, force = false, stderr, run = command }) {
  const nodeBin = await nodeBinDirectory(env);
  const selectedPrefix = prefix ? resolve(prefix) : process.platform === 'win32' ? nodeBin : dirname(nodeBin);
  const binDirectory = process.platform === 'win32' ? selectedPrefix : join(selectedPrefix, 'bin');
  const corepackPath = join(selectedPrefix, process.platform === 'win32' ? 'node_modules' : 'lib/node_modules', 'corepack/dist/corepack.js');
  if (!(await exists(corepackPath))) {
    if (prefix) await mkdir(binDirectory, { recursive: true });
    await access(binDirectory, fsConstants.W_OK).catch(() => {
      throw new Error(`Corepack needs a writable installation prefix. Use --corepack-prefix and add its bin directory to PATH: ${binDirectory}`);
    });
    const npmPath = await npmCli(env, nodeBin);
    const hostedWindows = process.platform === 'win32' && env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted';
    const args = [npmPath, 'install', '--global', COREPACK_SPEC, '--prefix', selectedPrefix,
      '--registry', PUBLIC_REGISTRY, '--no-audit', '--no-fund'];
    if (force || hostedWindows) args.push('--force');
    stderr.write('[yarn-helper] Installing Corepack.\n');
    const result = await run(args, { env, cwd, quiet: true });
    if (result.code !== 0 || !(await exists(corepackPath))) {
      throw new Error(`Corepack installation failed (${result.code}). ${result.errorOutput?.trim() ?? ''}`);
    }
  }
  const result = await run([corepackPath, 'enable', 'yarn', '--install-directory', binDirectory], { env, cwd, quiet: true });
  if (result.code !== 0) throw new Error(`Corepack could not enable Yarn (${result.code}). ${result.errorOutput?.trim() ?? ''}`);
  return { corepackPath, binDirectory, nodeBinDirectory: nodeBin };
}

export async function configureRegistry({ env, registry = 'https://npm.s24.dev/', tokenFile, home = env.HOME ?? env.USERPROFILE ?? homedir() }) {
  let token = env.PRIVATE_NPM_TOKEN;
  if (tokenFile) { const source = await readFile(tokenFile, 'utf8'); token = source.trim(); }
  if (!token || token === 'undefined' || token === 'null') return env;
  const url = new URL(registry);
  if (url.username || url.password) throw new Error('Registry credentials must be supplied through PRIVATE_NPM_TOKEN or --npm-token-file.');
  const normalize = value => value.replace(/^https?:/, '').replace(/\/+$/, '');
  const key = normalize(url.href);
  const filename = env.YARN_RC_FILENAME ?? '.yarnrc.yml';
  if (basename(filename) !== filename) throw new Error('YARN_RC_FILENAME must be a filename, not a path.');
  let file = join(home, filename);
  await mkdir(home, { recursive: true });
  let source = '';
  let mode = 0o600;
  try { source = await readFile(file, 'utf8'); const info = await stat(file); mode = info.mode & 0o777; file = await realpath(file); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const document = parseDocument(source);
  if (document.errors.length) throw new Error(`Cannot update ${filename}: ${document.errors[0].message}`);
  const entries = document.get('npmRegistries', true);
  const existing = entries?.items?.find(item => normalize(String(item.key.value)) === key)?.key.value;
  const registryKey = existing ?? key;
  document.setIn(['npmRegistries', registryKey, 'npmAuthToken'], '${PRIVATE_NPM_TOKEN:-}');
  document.setIn(['npmRegistries', registryKey, 'npmAlwaysAuth'], true);
  const updated = document.toString();
  if (updated !== source) {
    const temporary = `${file}.yarn-helper-${process.pid}-${Math.random().toString(16).slice(2)}`;
    try { await writeFile(temporary, updated, { mode, flag: 'wx' }); await rename(temporary, file); }
    finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  return { ...env, PRIVATE_NPM_TOKEN: token };
}
