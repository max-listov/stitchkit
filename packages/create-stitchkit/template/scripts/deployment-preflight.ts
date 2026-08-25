/**
 * The deployment a runtime smoke dials has to be there.
 *
 * `runtime:smoke` checks a RUNNING deployment — that is what makes it a runtime
 * smoke rather than a build check. Without this the first `fetch` inside some
 * assertion fails with a bare `ECONNRESET`, which reads like a broken check
 * instead of an absent deployment and says nothing about what to do next. The
 * packed lane never saw it because the lane starts the roles itself; everyone
 * following the README's gate list saw it first.
 */
export async function assertDeploymentIsAnswering(
  origins: Readonly<Record<string, string>>,
): Promise<void> {
  const closed: string[] = [];
  for (const [role, origin] of Object.entries(origins)) {
    if (!(await answers(origin))) closed.push(`${role} (${origin})`);
  }
  if (closed.length === 0) return;
  throw new Error(
    [
      `Nothing is listening for ${closed.join(' and ')}.`,
      '`runtime:smoke` checks a deployment that is already running, and the one it is about is',
      'the artifact `bun run build` produced: start it with `bun run pm2:prod`, then rerun.',
      '(`bun run dev` serves it too, from a development build.)',
      'If the deployment is somewhere else, point SMOKE_API_ORIGIN and SMOKE_WEB_ORIGIN at it.',
    ].join(' '),
  );
}

/**
 * Answering, not healthy: the checks that follow are what judge health. A role
 * that returns 404 for `/` has still proved the thing this asks about.
 */
async function answers(origin: string): Promise<boolean> {
  try {
    await fetch(new URL(origin), { method: 'HEAD', signal: AbortSignal.timeout(10_000) });
    return true;
  } catch {
    return false;
  }
}
