import { z } from 'zod';

const POLL_MS = 5_000;
const PackageManifestSchema = z.object({ name: z.string(), version: z.string() });

export interface NpmPublicationOptions {
  /** Total time to wait. Default: 30 minutes. */
  timeoutMs?: number;
  /** Registry transport; replaced in tests. */
  fetchPackage?: (url: string, init: { signal: AbortSignal }) => Promise<Response>;
}

/** Reads the registry document of one exact version and names why it is not the expected one. */
async function readVersion(
  fetchPackage: NonNullable<NpmPublicationOptions['fetchPackage']>,
  url: string,
  expected: { name: string; version: string },
  budgetMs: number,
): Promise<string | null> {
  try {
    const response = await fetchPackage(url, { signal: AbortSignal.timeout(budgetMs) });
    if (!response.ok) return `the registry returned HTTP ${response.status}`;
    const manifest = PackageManifestSchema.safeParse(await response.json());
    if (!manifest.success) return 'the registry returned invalid package metadata';
    const { name, version } = manifest.data;
    return name === expected.name && version === expected.version
      ? null
      : `the registry returned ${name}@${version}`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Polls the public registry until the exact package@version is visible or the monotonic deadline passes. */
export async function waitForNpmPublication(
  name: string,
  version: string,
  options: NpmPublicationOptions = {},
): Promise<{ attempts: number }> {
  if (!name || !version) throw new Error('Expected a package name and version');
  const timeoutMs = options.timeoutMs ?? 30 * 60 * 1_000;
  const fetchPackage = options.fetchPackage ?? globalThis.fetch;
  const url = `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
  const deadline = performance.now() + timeoutMs;
  let attempts = 0;
  let lastFailure = 'the registry gave no answer';
  for (let remaining = timeoutMs; remaining > 0; remaining = deadline - performance.now()) {
    attempts++;
    const failure = await readVersion(
      fetchPackage,
      `${url}?attempt=${attempts}`,
      { name, version },
      Math.min(POLL_MS, remaining),
    );
    if (failure === null) return { attempts };
    lastFailure = failure;
    console.warn(`Waiting for ${name}@${version} (attempt ${attempts}): ${failure}`);
    await Bun.sleep(Math.max(0, Math.min(POLL_MS, deadline - performance.now())));
  }
  throw new Error(
    `${name}@${version} did not become available from the public npm registry within ${timeoutMs}ms: ${lastFailure}`,
  );
}

if (import.meta.main) {
  const [name, version] = Bun.argv.slice(2);
  if (!name || !version)
    throw new Error('Usage: bun scripts/wait-for-npm-publication.ts <package> <version>');
  await waitForNpmPublication(name, version);
  console.log(`${name}@${version} is available from the public npm registry`);
}
