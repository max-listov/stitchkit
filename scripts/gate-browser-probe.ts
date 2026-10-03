import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';

// Keep upstream object receivers: object parsing would strip their internal state.
const ExecutableSchema = z.custom<{ executablePath(): string }>(
  (value) =>
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'executablePath') === 'function',
);
const RegistrySchema = z.custom<{ findExecutable(name: string): unknown }>(
  (value) =>
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'findExecutable') === 'function',
);
const BundleSchema = z.object({ registry: z.object({ registry: RegistrySchema }) });
const PackageSchema = z.object({ version: z.string() });

/** The selected runtime's registry owns every platform/override/hermetic resolution. */
export async function measureBrowserRuntime(
  packageRoot: string,
  version: string,
): Promise<string> {
  // The generated project declares @playwright/test. Bun may nest both of its
  // dependencies, so resolve each dependency from its actual importing package.
  const testEntry = Bun.resolveSync('@playwright/test', packageRoot);
  const playwrightEntry = Bun.resolveSync('playwright', dirname(testEntry));
  const manifest = Bun.resolveSync('playwright-core/package.json', dirname(playwrightEntry));
  const installed = PackageSchema.parse(JSON.parse(await readFile(manifest, 'utf8')));
  if (installed.version !== version)
    throw new Error('Selected Playwright runtime version differs');
  const bundleEntry = Bun.resolveSync(
    'playwright-core/lib/coreBundle',
    dirname(playwrightEntry),
  );
  const bundle: unknown = await import(bundleEntry);
  const { registry } = BundleSchema.parse(bundle).registry;
  // The generated config uses default headless Chromium and WebKit. Upstream's
  // Chromium.getExecutableName selects the headless shell, not full Chrome.
  const selected = ['chromium-headless-shell', 'webkit'].map((name) =>
    ExecutableSchema.parse(registry.findExecutable(name)),
  );
  const files = await Promise.all(
    selected.map(async (browser) => {
      const path = browser.executablePath();
      const info = await stat(path, { bigint: true });
      if (!info.isFile()) throw new Error('Browser executable is not a file');
      return {
        path,
        size: String(info.size),
        mtime: String(info.mtimeNs),
        ctime: String(info.ctimeNs),
        inode: String(info.ino),
        device: String(info.dev),
        mode: String(info.mode),
      };
    }),
  );
  return `browsers:${version}:${createHash('sha256').update(JSON.stringify(files)).digest('hex')}`;
}

if (import.meta.main) {
  const [packageRoot, version] = Bun.argv.slice(2);
  try {
    if (!packageRoot || !version) throw new Error('Missing browser runtime context');
    process.stdout.write(await measureBrowserRuntime(packageRoot, version));
  } catch {
    process.exitCode = 1;
  }
}
