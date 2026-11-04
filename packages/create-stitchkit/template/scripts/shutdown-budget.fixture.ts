/**
 * A role whose cleanup will not complete, as a real process.
 *
 * A promise cannot prove process termination: setting `process.exitCode` still
 * waits for an event loop with held handles. The role must exit before the
 * supervisor's SIGKILL, and only a real process can demonstrate that bound.
 *
 * The interval below is the held handle. Nothing ever clears it, so this
 * process ends only if something ends it — which is the assertion.
 */
import { closeWithinBudget, concludeShutdown } from '../packages/backend/src/cleanup';

setInterval(() => undefined, 1_000);

const budgetMs = Number(Bun.argv[2] ?? '200');
const mode = Bun.argv[3] ?? 'hang';

const steps = {
  hang: { name: 'database', close: () => new Promise<void>(() => undefined) },
  throw: { name: 'database', close: () => Promise.reject(new Error('pool already gone')) },
  clean: { name: 'database', close: () => Promise.resolve() },
};
const step = steps[mode === 'throw' ? 'throw' : mode === 'clean' ? 'clean' : 'hang'];

const result = await closeWithinBudget([step], budgetMs);
console.log(`FIXTURE ${JSON.stringify({ unfinished: result.unfinished })}`);
concludeShutdown(result, true);
