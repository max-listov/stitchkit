/**
 * A role whose cleanup will not complete, as a real process.
 *
 * The regression this serves cannot be written against a promise. The defect
 * was never "the helper resolved late" — it was that the role set
 * `process.exitCode` and then waited for an event loop something was still
 * holding, so the process lived until the supervisor's SIGKILL: exactly the
 * ending the cleanup budget exists to prevent. Only a process can show that.
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
