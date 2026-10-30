import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { stripVTControlCharacters } from 'node:util';

const CANCEL_ERROR = 'Error: The `onCancel` handler was attached after the promise settled.';
const NON_FATAL_CODES = new Set(['YN0000', 'YN0002', 'YN0013', 'YN0060', 'YN0068', 'YN0069', 'YN0086']);
const OUTPUT_TAIL_LIMIT = 64 * 1024;

export function signalExitCode(signal) {
  return 128 + (constants.signals[signal] ?? 1);
}

/** Never retry linking, lifecycle scripts, integrity errors, or arbitrary command failures. */
export async function runYarn(args, {
  corepackPath,
  cwd = process.cwd(),
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  retryDelays = [2000, 5000],
  signal
}) {
  const install = args.length === 0 || args[0] === 'install' || (args[0] === 'workspaces' && args[1] === 'focus');
  const cancellation = new AbortController();
  let activeChild;
  let forceTimer;
  const stop = reason => {
    if (cancellation.signal.aborted) return;
    const name = typeof reason === 'string' ? reason : 'SIGTERM';
    cancellation.abort(name);
    activeChild?.kill(name);
    if (activeChild) forceTimer = setTimeout(() => activeChild?.kill('SIGKILL'), 5000).unref();
  };
  const interrupt = () => stop('SIGINT');
  const terminate = () => stop('SIGTERM');
  const abort = () => stop(signal.reason);
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();

  try {
    for (let attempt = 0; ; attempt++) {
      if (cancellation.signal.aborted) return signalExitCode(cancellation.signal.reason);
      let outputTail = '';
      let fetching = false;
      let linking = false;
      let reportedFailure = false;
      const observe = chunk => {
        outputTail = (outputTail + chunk.toString()).slice(-OUTPUT_TAIL_LIMIT);
        const plainTail = stripVTControlCharacters(outputTail);
        for (const match of plainTail.matchAll(/^➤ (YN\d{4}): ([^\n]*)/gm)) {
          fetching ||= match[1] === 'YN0000' && match[2].startsWith('┌ Fetch step');
          linking ||= match[1] === 'YN0000' && match[2].startsWith('┌ Link step');
          if (!NON_FATAL_CODES.has(match[1])) reportedFailure = true;
        }
      };
      const child = spawn(process.execPath, [corepackPath, 'yarn', ...args], {
        cwd, env, stdio: ['inherit', 'pipe', 'pipe']
      });
      activeChild = child;
      child.stdout.on('data', chunk => { observe(chunk); stdout.write(chunk); });
      child.stderr.on('data', chunk => { observe(chunk); stderr.write(chunk); });
      const result = await new Promise((resolveExit, reject) => {
        child.once('error', reject);
        child.once('close', (code, exitSignal) => resolveExit({ code: code ?? 1, signal: exitSignal }));
      });
      activeChild = undefined;
      clearTimeout(forceTimer);
      if (cancellation.signal.aborted) return signalExitCode(cancellation.signal.reason);
      if (result.signal) return signalExitCode(result.signal);
      if (result.code === 0) return 0;

      const yarnStack = /[\\/](?:yarn-[^\s:]+\.cjs|yarn\.(?:js|cjs)):\d+:\d+/.test(outputTail);
      const cancellationError = stripVTControlCharacters(outputTail).split(/\r?\n/).includes(CANCEL_ERROR);
      const retryable = install && fetching && !linking && !reportedFailure && cancellationError && yarnStack;
      if (!retryable || attempt >= retryDelays.length) return result.code;
      const waitMs = retryDelays[attempt];
      stderr.write(`[yarn-helper] Yarn fetch cancellation crash; retry ${attempt + 1}/${retryDelays.length} in ${waitMs / 1000}s.\n`);
      try {
        await delay(waitMs, undefined, { signal: cancellation.signal });
      } catch (error) {
        if (!cancellation.signal.aborted) throw error;
      }
    }
  } finally {
    clearTimeout(forceTimer);
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
    signal?.removeEventListener('abort', abort);
  }
}
