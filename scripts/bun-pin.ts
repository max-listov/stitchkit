import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The Bun version CI runs, and every place that names it.
 *
 * A local gate on another Bun answers for a toolchain CI does not use: 0.119.0
 * passed `verify` on Bun 1.4.4 and failed CI on 1.4.2, where relative `link:`
 * dependencies do not install. The workflows, the starter image step and every
 * `packageManager` name one version, and the gate's own test suite runs only on it.
 */
const PIN_FILES = {
  workflows: [
    '.github/workflows/ci.yml',
    '.github/workflows/ci-retry.yml',
    '.github/workflows/release.yml',
  ],
  manifests: [
    'packages/tui/package.json',
    'packages/create-stitchkit/package.json',
    'packages/create-stitchkit/template/package.json',
    'packages/create-stitchkit/templates/agent/package.json',
    'packages/create-stitchkit/templates/telegram-bot/package.json',
    'packages/core/tests/fixtures/next-ssr-retry/package.json',
  ],
};

/** Every `path: version` a Bun pin names, read from the files themselves. */
export function bunPins(read: (path: string) => string): string[] {
  const pins: string[] = [];
  for (const path of PIN_FILES.workflows) {
    for (const match of read(path).matchAll(/(?:bun-version|BUN_VERSION): ([^\s]+)/g)) {
      pins.push(`${path}: ${match[1]}`);
    }
  }
  for (const path of PIN_FILES.manifests) {
    const manager = /"packageManager": "bun@([^"]+)"/.exec(read(path))?.[1];
    pins.push(`${path}: ${manager ?? '(none)'}`);
  }
  return pins;
}

/** The one pinned version; throws, naming each pin, when they disagree. */
export function pinnedBun(read: (path: string) => string): string {
  const pins = bunPins(read);
  const versions = new Set(pins.map((pin) => pin.slice(pin.lastIndexOf(' ') + 1)));
  const [version] = versions;
  if (versions.size !== 1 || version === undefined || version === '(none)') {
    throw new Error(`Bun pins disagree:\n  ${pins.join('\n  ')}`);
  }
  return version;
}

/** Refuse a gate on a Bun other than the one CI runs. */
export function assertPinnedBun(root: string, running = Bun.version): void {
  const pinned = pinnedBun((path) => readFileSync(join(root, path), 'utf8'));
  if (running !== pinned) {
    throw new Error(
      `Bun ${running} is running, CI runs Bun ${pinned}; a green gate here would not answer for CI. Run the gate on Bun ${pinned}, or move every pin together.`,
    );
  }
}

/**
 * The starter container installs Bun from npm's `@oven/bun-linux-x64` tarball and checks it
 * against `BUN_ARCHIVE_SHA512`. Moving the version without that digest is invisible to every
 * local gate and fails four CI jobs (0.126.0 shipped a digest of another archive), so the digest
 * is compared with npm's own `dist.integrity` for the pinned version.
 */
export async function assertBunArchiveDigest(
  read: (path: string) => string,
  integrityOf: (version: string) => Promise<string> = npmBunIntegrity,
): Promise<void> {
  const version = pinnedBun(read);
  const digest = /BUN_ARCHIVE_SHA512: ([0-9a-f]{128})\b/.exec(
    read('.github/workflows/ci.yml'),
  )?.[1];
  if (digest === undefined) throw new Error('.github/workflows/ci.yml: no BUN_ARCHIVE_SHA512');
  const integrity = await integrityOf(version);
  const expected = Buffer.from(integrity.replace(/^sha512-/, ''), 'base64').toString('hex');
  if (digest !== expected) {
    throw new Error(
      `.github/workflows/ci.yml: BUN_ARCHIVE_SHA512 is not the digest of @oven/bun-linux-x64@${version} (npm: ${expected})`,
    );
  }
}

async function npmBunIntegrity(version: string): Promise<string> {
  const response = await fetch(`https://registry.npmjs.org/@oven/bun-linux-x64/${version}`);
  if (!response.ok)
    throw new Error(`npm @oven/bun-linux-x64@${version}: HTTP ${response.status}`);
  const body: { dist?: { integrity?: string } } = await response.json();
  const integrity = body.dist?.integrity;
  if (integrity === undefined)
    throw new Error(`npm @oven/bun-linux-x64@${version}: no integrity`);
  return integrity;
}
