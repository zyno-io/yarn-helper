import { readFile } from 'node:fs/promises';
import { delimiter } from 'node:path';
import { configureRegistry, ensureCorepack, findProject } from './bootstrap.mjs';
import { runYarn } from './runner.mjs';

const HELP = `Usage: yarn-helper [options] [setup | Yarn arguments...]

Bootstrap Corepack and execute the project's declared Yarn version.

  yarn-helper install --immutable
  yarn-helper setup
  yarn-helper workspaces focus my-workspace --production

Helper options (before the Yarn command):
  --npm-token-file <file>   Read the private registry token from a mounted secret
  --npm-registry <url>      Token's registry (default: https://npm.s24.dev/)
  --corepack-prefix <path>  Install Corepack in this prefix instead of Node's prefix
  --force-corepack          Allow npm to replace existing package-manager shims
  --help, -h                Show this help
  --version, -v             Show the helper version
  --                        Pass all remaining arguments directly to Yarn
`;

export function parseArgs(args) {
  const options = {};
  const values = new Map([['--npm-token-file', 'tokenFile'], ['--npm-registry', 'registry'], ['--corepack-prefix', 'prefix']]);
  let index = 0;
  for (; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') { index++; break; }
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--version' || arg === '-v') return { version: true };
    if (arg === '--force-corepack') { options.force = true; continue; }
    if (!values.has(arg)) break;
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value.`);
    options[values.get(arg)] = value;
  }
  return { options, yarnArgs: args.slice(index) };
}

export async function main(args, { cwd = process.cwd(), env = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
  const parsed = parseArgs(args);
  if (parsed.help) { stdout.write(HELP); return 0; }
  if (parsed.version) {
    const source = await readFile(new URL('../package.json', import.meta.url), 'utf8');
    stdout.write(`${JSON.parse(source).version}\n`);
    return 0;
  }
  const setup = parsed.yarnArgs.length === 1 && parsed.yarnArgs[0] === 'setup';
  const project = await findProject(cwd);
  const yarnProject = project && (project.manager.startsWith('yarn@') || project.manager === 'yarn');
  if (!setup && !yarnProject) throw new Error('Declare Yarn in package.json packageManager (or devEngines.packageManager) before running Yarn commands.');
  let childEnv = { ...env, COREPACK_ENABLE_AUTO_PIN: '0', COREPACK_DEFAULT_TO_LATEST: '0', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' };
  const prepared = await ensureCorepack({ ...parsed.options, env: childEnv, cwd, stderr });
  childEnv.PATH = `${prepared.binDirectory}${delimiter}${prepared.nodeBinDirectory}${delimiter}${childEnv.PATH ?? childEnv.Path ?? ''}`;
  childEnv = await configureRegistry({ ...parsed.options, env: childEnv });
  if (setup) {
    if (yarnProject) {
      const code = await runYarn(['--version'], { corepackPath: prepared.corepackPath, cwd, env: childEnv, stdout, stderr });
      if (code !== 0) return code;
    }
    stderr.write('[yarn-helper] Corepack and Yarn are ready.\n');
    return 0;
  }
  return runYarn(parsed.yarnArgs, { corepackPath: prepared.corepackPath, cwd, env: childEnv, stdout, stderr });
}
