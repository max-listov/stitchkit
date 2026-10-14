import type { InstalledConsumerProof } from './installed-proof-contract';
import { installedConsumerProofs } from './installed-proofs';

/**
 * Run the registered installed-package proofs that apply to one fixture and platform. Platform and
 * capability verdicts are settled first; the proofs that remain run through a bounded pool.
 */
export async function runInstalledConsumerProofs(input: {
  fixture?: InstalledConsumerProof['fixture'];
  /** Several fixtures in one pool; a proof of a fixture outside the list is not run. */
  fixtures?: readonly string[];
  platform: NodeJS.Platform;
  uid?: number;
  ids?: readonly string[];
  requireCapabilities?: boolean;
  /**
   * How many proof processes may run at once; 1 by default. Each proof owns its own temporary
   * directories, so independent proofs overlap and the slowest one bounds the lane.
   */
  concurrency?: number;
  run: (proof: InstalledConsumerProof, runtime: 'bun' | 'node' | 'types') => Promise<string>;
  verdict: (
    proof: InstalledConsumerProof,
    runtime: 'bun' | 'node' | 'types' | 'platform',
    state: 'succeeded' | 'not-applicable' | 'failed',
  ) => void;
}): Promise<void> {
  const jobs: { proof: InstalledConsumerProof; runtime: 'bun' | 'node' | 'types' }[] = [];
  for (const proof of installedConsumerProofs) {
    if (input.ids && !input.ids.includes(proof.id)) continue;
    if (input.fixture && proof.fixture !== input.fixture) continue;
    if (input.fixtures && !input.fixtures.includes(proof.fixture)) continue;
    if (proof.capability === 'linux-root' && (input.platform !== 'linux' || input.uid !== 0)) {
      if (input.requireCapabilities) {
        input.verdict(proof, 'platform', 'failed');
        throw new Error(`Installed proof ${proof.id} requires Linux UID0`);
      }
      input.verdict(proof, 'platform', 'not-applicable');
      continue;
    }
    if (!proof.platforms.some((platform) => platform === input.platform)) {
      input.verdict(proof, 'platform', 'not-applicable');
      continue;
    }
    const runtimes: ('bun' | 'node' | 'types')[] =
      proof.kind === 'declarations' ? ['types'] : proof.runtimes;
    for (const runtime of runtimes) jobs.push({ proof, runtime });
  }

  type Job = (typeof jobs)[number];
  let failure: { error: unknown } | undefined;
  const runJob = async ({ proof, runtime }: Job): Promise<void> => {
    try {
      for (let attempt = 0; attempt < (proof.repetitions ?? 1); attempt++) {
        const output = await input.run(proof, runtime);
        if (
          proof.kind === 'runtime' &&
          !output.split(/\r?\n/).some((line) => line === proof.marker)
        )
          throw new Error(
            `Installed proof ${proof.id}/${runtime} has no exact success marker`,
          );
      }
      input.verdict(proof, runtime, 'succeeded');
    } catch (error) {
      input.verdict(proof, runtime, 'failed');
      failure ??= { error };
    }
  };

  // With room for more than one proof, an idle proof loads nothing and shares nothing, so it starts
  // now and runs beside all the rest; one proof at a time means exactly that.
  const parallel = (input.concurrency ?? 1) > 1;
  const aside = (job: Job) => parallel && job.proof.idle === true;
  const idle = Promise.all(jobs.filter(aside).map(runJob));
  // Longest first: the lane then lasts as long as its slowest proof, not that proof plus a tail.
  const shared = jobs
    .filter((job) => job.proof.exclusive !== true && !aside(job))
    .sort((a, b) => (b.proof.expectedMs ?? 0) - (a.proof.expectedMs ?? 0));
  // The first failure stops new proofs from starting; the ones in flight settle before it is thrown.
  let next = 0;
  const worker = async (): Promise<void> => {
    while (failure === undefined) {
      const job = shared[next];
      if (job === undefined) return;
      next += 1;
      await runJob(job);
    }
  };
  const width = Math.max(1, Math.min(input.concurrency ?? 1, shared.length));
  await Promise.all(Array.from({ length: width }, worker));
  // An exclusive proof runs once nothing but idle proofs is in flight.
  for (const job of jobs) {
    if (failure !== undefined) break;
    if (job.proof.exclusive === true) await runJob(job);
  }
  await idle;
  if (failure !== undefined) throw failure.error;
}
