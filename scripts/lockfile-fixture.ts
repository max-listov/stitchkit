/**
 * Test support: the `bun.lock` a synthetic release tree carries, written from that tree's own
 * workspace manifests so `release:check` reads a lock that records them, as `bun install` would.
 */
import { LOCKED_WORKSPACES } from './release-lockfile';

const ROOT_MANIFEST = '{"name":"fixture-monorepo","private":true}';

function manifestPath(directory: string): string {
  return directory === '' ? 'package.json' : `${directory}/package.json`;
}

/** `files` with a root manifest when it has none and the `bun.lock` its workspace manifests call for. */
export function withLockfile(files: Record<string, string>): Record<string, string> {
  const tree: Record<string, string> = { 'package.json': ROOT_MANIFEST, ...files };
  const workspaces: Record<string, Record<string, unknown>> = {};
  for (const directory of LOCKED_WORKSPACES) {
    const source = tree[manifestPath(directory)];
    if (source === undefined) continue;
    const manifest: Record<string, unknown> = JSON.parse(source);
    const meta = manifest.peerDependenciesMeta;
    const optionalPeers =
      typeof meta === 'object' && meta !== null
        ? Object.entries(meta)
            .filter(([, entry]) => Reflect.get(Object(entry), 'optional') === true)
            .map(([name]) => name)
        : [];
    workspaces[directory] = {
      name: manifest.name,
      ...(manifest.version !== undefined && { version: manifest.version }),
      ...Object.fromEntries(
        ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
          .filter((field) => manifest[field] !== undefined)
          .map((field) => [field, manifest[field]]),
      ),
      ...(optionalPeers.length > 0 && { optionalPeers }),
    };
  }
  return {
    ...tree,
    'bun.lock': `${JSON.stringify({ lockfileVersion: 1, workspaces }, null, 2)}\n`,
  };
}
