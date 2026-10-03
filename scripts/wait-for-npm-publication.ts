import { z } from 'zod';

export const DEFAULT_NPM_PUBLICATION_TIMEOUT_MS = 30 * 60 * 1_000;
const PollingOptionsSchema = z.strictObject({
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(2 ** 31 - 1)
    .default(DEFAULT_NPM_PUBLICATION_TIMEOUT_MS),
  requestTimeoutMs: z
    .number()
    .int()
    .positive()
    .max(2 ** 31 - 1)
    .default(5_000),
  retryDelayMs: z
    .number()
    .int()
    .positive()
    .max(2 ** 31 - 1)
    .default(5_000),
});
const PackageManifestSchema = z.object({ name: z.string(), version: z.string() });
export type NpmPublicationPollingOptions = z.input<typeof PollingOptionsSchema>;
export interface NpmPublicationDependencies {
  now: () => number;
  fetch: (
    url: string,
    options: { headers: HeadersInit; signal: AbortSignal },
  ) => Promise<Response>;
  sleep: (milliseconds: number) => Promise<void>;
  onRetry: (message: string) => void;
}

/** The timer bounds the whole operation, including a stalled body or an uncooperative test transport. */
async function withinBudget<T>(
  milliseconds: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(
    () =>
      controller.abort(new Error(`registry operation exceeded its ${milliseconds}ms budget`)),
    Math.ceil(milliseconds),
  );
  try {
    return await new Promise<T>((resolve, reject) => {
      const aborted = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', aborted, { once: true });
      operation(controller.signal).then(
        (result) => {
          controller.signal.removeEventListener('abort', aborted);
          resolve(result);
        },
        (error: unknown) => {
          controller.signal.removeEventListener('abort', aborted);
          reject(error);
        },
      );
    });
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/**
 * Exact public registry identity, bounded by one elapsed monotonic deadline.
 * The total budget covers requests, response bodies, parsing and retry sleeps;
 * the request budget covers both headers and body. A late exact response is refused.
 */
export async function waitForNpmPublication(
  packageName: string,
  expectedVersion: string,
  options: NpmPublicationPollingOptions = {},
  dependencies: Partial<NpmPublicationDependencies> = {},
): Promise<{ attempts: number; elapsedMs: number }> {
  if (!packageName || !expectedVersion) throw new Error('Expected a package name and version');
  const policy = PollingOptionsSchema.parse(options);
  const now = dependencies.now ?? (() => performance.now());
  const fetchPackage = dependencies.fetch ?? globalThis.fetch;
  const sleep = dependencies.sleep ?? ((milliseconds) => Bun.sleep(milliseconds));
  const onRetry = dependencies.onRetry ?? console.warn;
  const started = now();
  const deadline = started + policy.timeoutMs;
  const remaining = () => Math.max(0, deadline - now());
  const packagePath = `${encodeURIComponent(packageName)}/${encodeURIComponent(expectedVersion)}`;
  let attempts = 0;
  let lastFailure = 'the registry returned no response';

  while (remaining() > 0) {
    attempts++;
    const requestBudget = Math.min(policy.requestTimeoutMs, remaining());
    if (requestBudget <= 0) break;
    const requestDeadline = now() + requestBudget;
    const requireTimelyResponse = () => {
      if (now() >= Math.min(deadline, requestDeadline))
        throw new Error('the registry response arrived after its elapsed deadline');
    };
    try {
      const available = await withinBudget(requestBudget, async (signal) => {
        const response = await fetchPackage(
          `https://registry.npmjs.org/${packagePath}?attempt=${attempts}`,
          { headers: { accept: 'application/json' }, signal },
        );
        requireTimelyResponse();
        if (!response.ok) {
          lastFailure = `the registry returned HTTP ${response.status}`;
          return false;
        }
        const body: unknown = await response.json();
        requireTimelyResponse();
        const manifest = PackageManifestSchema.safeParse(body);
        if (!manifest.success) {
          lastFailure = 'the registry returned invalid package metadata';
          return false;
        }
        if (manifest.data.name !== packageName || manifest.data.version !== expectedVersion) {
          lastFailure = `the registry returned ${manifest.data.name}@${manifest.data.version}`;
          return false;
        }
        return true;
      });
      if (available && remaining() > 0) return { attempts, elapsedMs: now() - started };
      if (available)
        lastFailure = 'the registry metadata was confirmed after the elapsed deadline';
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }

    if (remaining() <= 0) break;
    onRetry(
      `Waiting for ${packageName}@${expectedVersion} (attempt ${attempts}): ${lastFailure}`,
    );
    const sleepBudget = remaining();
    if (sleepBudget <= 0) break;
    try {
      await withinBudget(sleepBudget, () => sleep(Math.min(policy.retryDelayMs, sleepBudget)));
    } catch (error) {
      if (remaining() > 0) throw error;
      break;
    }
  }
  throw new Error(
    `${packageName}@${expectedVersion} did not become available from the public npm registry within ${policy.timeoutMs}ms: ${lastFailure}`,
  );
}

if (import.meta.main) {
  const [packageName, expectedVersion] = Bun.argv.slice(2);
  if (!packageName || !expectedVersion)
    throw new Error('Usage: bun scripts/wait-for-npm-publication.ts <package> <version>');
  await waitForNpmPublication(packageName, expectedVersion);
  console.log(`${packageName}@${expectedVersion} is available from the public npm registry`);
}
