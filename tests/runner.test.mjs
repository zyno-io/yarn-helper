import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runYarn } from '../src/runner.mjs';

const FETCH = '\u001b[94m➤ YN0000: ┌ Fetch step\u001b[0m\n';
const CRASH = 'Error: The `onCancel` handler was attached after the promise settled.\n';
const STACK = '    at x (/root/.cache/node/corepack/v1/yarn/4.17.1/yarn.js:141:21)\n';

async function fixture({ failures = 0, output = FETCH + CRASH + STACK, exitCode = 73 } = {}) {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'yarn-helper-runner-'));
  const directory = await realpath(temporaryDirectory);
  const attempts = join(directory, 'attempts.jsonl');
  const corepackPath = join(directory, 'corepack.cjs');
  await writeFile(corepackPath, `
    const fs = require('node:fs');
    const attempts = ${JSON.stringify(attempts)};
    const prior = fs.existsSync(attempts) ? fs.readFileSync(attempts, 'utf8').trim().split('\\n').length : 0;
    fs.appendFileSync(attempts, JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),flag:process.env.TEST_FLAG})+'\\n');
    if (prior < ${failures}) { process.stdout.write(${JSON.stringify(output)}); process.exitCode=${exitCode}; }
    else { process.stdout.write('success\\n'); process.stderr.write('stderr preserved\\n'); }
  `);
  let stdout = '';
  let stderr = '';
  return {
    directory, corepackPath,
    run: (args, options = {}) => runYarn(args, {
      corepackPath, cwd: directory, env: { ...process.env, TEST_FLAG: 'kept' }, retryDelays: [0, 0],
      stdout: { write: chunk => { stdout += chunk; } },
      stderr: { write: chunk => { stderr += chunk; } }, ...options
    }),
    output: () => ({ stdout, stderr }),
    attempts: async () => { const source = await readFile(attempts, 'utf8'); return source.trim().split('\n').map(line => JSON.parse(line)); },
    dispose: () => rm(directory, { recursive: true, force: true })
  };
}

test('preserves literal arguments, cwd, environment, stdout, stderr and success', async () => {
  const job = await fixture();
  try {
    const args = ['install', '--immutable', '--cache-folder', 'literal $(text) with spaces'];
    const code = await job.run(args);
    const attempts = await job.attempts();
    assert.equal(code, 0);
    assert.deepEqual(attempts, [{ args: ['yarn', ...args], cwd: job.directory, flag: 'kept' }]);
    assert.deepEqual(job.output(), { stdout: 'success\n', stderr: 'stderr preserved\n' });
  } finally { await job.dispose(); }
});

for (const args of [[], ['install', '--immutable'], ['workspaces', 'focus', '@example/api', '--production']]) {
  test(`recovers from at most two pre-link cancellation crashes: ${args.join(' ')}`, async () => {
    const job = await fixture({ failures: 2, output: FETCH + '➤ YN0069: Redundant package extension warning\n' + CRASH + STACK });
    try {
      const code = await job.run(args);
      const attempts = await job.attempts();
      assert.equal(code, 0);
      assert.equal(attempts.length, 3);
      assert.ok(attempts.every(item => JSON.stringify(item.args) === JSON.stringify(['yarn', ...args])));
      assert.equal(job.output().stderr.match(/retry \d\/2/g).length, 2);
    } finally { await job.dispose(); }
  });
}

test('preserves the final failure after the bounded number of attempts', async () => {
  const job = await fixture({ failures: 99 });
  try {
    const code = await job.run(['install']);
    const attempts = await job.attempts();
    assert.equal(code, 73);
    assert.equal(attempts.length, 3);
  } finally { await job.dispose(); }
});

for (const [name, args, output] of [
  ['linking started', ['install'], FETCH + '➤ YN0000: ┌ Link step\n' + CRASH + STACK],
  ['checksum mismatch', ['install'], FETCH + '➤ YN0018: Bad checksum\n' + CRASH + STACK],
  ['authentication error', ['install'], FETCH + '➤ YN0041: Authentication failed\n' + CRASH + STACK],
  ['lifecycle error', ['install'], FETCH + '➤ YN0009: Build failed\n' + CRASH + STACK],
  ['no fetch phase', ['install'], CRASH + STACK],
  ['unrelated stack', ['install'], FETCH + CRASH + ' at task (/app/foo.js:1:1)\n'],
  ['ordinary command', ['build'], FETCH + CRASH + STACK],
  ['different exception', ['install'], FETCH + 'Error: another failure\n' + STACK]
]) {
  test(`does not retry ${name}`, async () => {
    const job = await fixture({ failures: 99, output });
    try {
      const code = await job.run(args);
      const attempts = await job.attempts();
      assert.equal(code, 73);
      assert.equal(attempts.length, 1);
    } finally { await job.dispose(); }
  });
}

test('supports a vendored Yarn stack on Windows', async () => {
  const job = await fixture({ failures: 1, output: FETCH + CRASH + ' at x (C:\\repo\\.yarn\\releases\\yarn-4.18.0.cjs:2:3)\n' });
  try { const code = await job.run(['install']); assert.equal(code, 0); }
  finally { await job.dispose(); }
});

test('aborting during retry backoff prevents any later attempt', async () => {
  const job = await fixture({ failures: 99 });
  const controller = new AbortController();
  try {
    const result = job.run(['install'], {
      signal: controller.signal, retryDelays: [30_000, 30_000],
      stderr: { write: chunk => { if (String(chunk).includes('retry 1/2')) controller.abort('SIGTERM'); } }
    });
    const code = await result;
    const attempts = await job.attempts();
    assert.equal(code, 143);
    assert.equal(attempts.length, 1);
  } finally { await job.dispose(); }
});

test('SIGTERM reaches an active child and prevents retrying it', { skip: process.platform === 'win32' }, async () => {
  const job = await fixture();
  await writeFile(job.corepackPath, `process.stdout.write('ready\\n'); setInterval(() => {}, 1000);`);
  const worker = join(job.directory, 'worker.mjs');
  await writeFile(worker, `
    import {runYarn} from ${JSON.stringify(new URL('../src/runner.mjs', import.meta.url).href)};
    process.exitCode = await runYarn(['install'], {corepackPath:${JSON.stringify(job.corepackPath)}});
  `);
  try {
    const child = spawn(process.execPath, [worker], { stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = new Promise(resolveExit => child.once('exit', resolveExit));
    await new Promise((resolveReady, reject) => {
      child.once('error', reject);
      child.stdout.once('data', () => { child.kill('SIGTERM'); resolveReady(); });
    });
    const code = await exited;
    assert.equal(code, 143);
  } finally { await job.dispose(); }
});

test('aborting an active child stops it on every platform', async () => {
  const job = await fixture();
  await writeFile(job.corepackPath, "process.stdout.write('ready\\n'); setInterval(() => {}, 1000);");
  const controller = new AbortController();
  try {
    const code = await job.run(['install'], {
      signal: controller.signal,
      stdout: { write: () => controller.abort('SIGTERM') }
    });
    assert.equal(code, 143);
  } finally { await job.dispose(); }
});
