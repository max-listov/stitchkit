/** Child side of `operation-process.test.ts`: the real handlers, one call per process. */
import { writeFileSync } from 'node:fs';
import { AppError } from '../../src/entrypoints/contract';
import { implement } from '../../src/entrypoints/server';
import { runOperationProcess } from '../../src/process/operation-child';
import { heavyContract } from './operation-process-contract';

function locked(): AppError {
  return new AppError('RECORD_LOCKED', {
    message: 'The record is locked',
    status: 423,
    details: { record: 'r-1' },
    retryable: true,
  });
}

const service = implement(heavyContract, {
  search: async ({ input, signal }) => {
    if (input.pidFile) writeFileSync(input.pidFile, String(process.pid));
    if (input.mode === 'refuse') throw locked();
    if (input.mode === 'crash') process.exit(3);
    if (input.mode === 'big') return { matches: ['x'.repeat(200_000)] };
    if (input.mode === 'noisy') process.stderr.write('diagnostic line\n'.repeat(20_000));
    if (input.mode === 'hang') {
      await new Promise((resolve) => signal?.addEventListener('abort', resolve));
      return { matches: [] };
    }
    // Hold this process's own loop, as a real scan would — blocked, not spinning,
    // so the test does not take a core from its neighbours.
    Bun.sleepSync(input.busyMs ?? 0);
    return { matches: [`found:${input.query}:${input.padding?.length ?? 0}`] };
  },
  ping: () => ({ ok: true }),
  follow: ({ input }) =>
    (async function* () {
      for (let n = 1; n <= input.count; n += 1) {
        if (input.mode === 'refuse' && n === 2) throw locked();
        yield input.mode === 'big' && n === 2 ? { n, text: 'x'.repeat(200_000) } : { n };
        await Bun.sleep(input.gapMs ?? 0);
      }
    })(),
  linger: ({ input }) =>
    (async function* () {
      writeFileSync(input.pidFile, String(process.pid));
      for (let n = 1; ; n += 1) {
        yield { n };
        await Bun.sleep(50);
      }
    })(),
});

process.exitCode = await runOperationProcess([service]);
