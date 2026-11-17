import { z } from 'zod';
import { withDeadline } from '../../internal/deadline';
import { isRecord } from '../../internal/typed';
import { type McpCatalogStamp, readMcpCatalogStamp } from '../mcp/catalog-stamp';
import type { McpConnectionCatalogEntry, McpConnectionCatalogStore } from './types';

/**
 * A connection's discovered catalog, kept by the application between processes and used only
 * while it is provably the one the server serves now.
 *
 * The key is the server's catalog stamp — a digest of everything its `tools/list` publishes for
 * the caller's surface — never `serverInfo`, whose version a server rarely changes and which says
 * nothing about which surface a credential sees. `initialize` and `tools/list` are separate
 * requests a rolling deploy can answer from two builds, so a listing is stored only when every
 * tool in it carries the stamp `initialize` announced and their number matches; a stored entry is
 * used only on the same proof. Anything else costs one `tools/list`, which is what the
 * connection did before it had a store.
 */

const StoredEntrySchema = z.object({
  stamp: z.object({ digest: z.string().min(1), tools: z.int().nonnegative() }),
  result: z.unknown(),
});

function sameStamp(left: McpCatalogStamp | null, right: McpCatalogStamp): boolean {
  return left !== null && left.digest === right.digest && left.tools === right.tools;
}

/** Every listed tool carries `stamp`, and there are exactly `stamp.tools` of them. */
function listedUnder(result: unknown, stamp: McpCatalogStamp): boolean {
  if (!isRecord(result) || !Array.isArray(result.tools)) return false;
  if (result.tools.length !== stamp.tools) return false;
  return result.tools.every(
    (tool) => isRecord(tool) && sameStamp(readMcpCatalogStamp(tool._meta), stamp),
  );
}

/** A store is local state: one that has not answered in this long is a miss, not a wait. */
const STORE_TIMEOUT_MS = 10_000;

async function loadEntry(
  store: McpConnectionCatalogStore,
): Promise<McpConnectionCatalogEntry | undefined> {
  try {
    const loaded = await withDeadline(Promise.resolve(store.load()), STORE_TIMEOUT_MS);
    if (!loaded.settled) return undefined;
    const parsed = StoredEntrySchema.safeParse(loaded.value);
    return parsed.success ? parsed.data : undefined;
  } catch {
    // A store that cannot read is a cache miss; the server still answers.
    return undefined;
  }
}

/** The `tools/list` result: the stored one when it is the served catalog, else a fresh one. */
export async function listMcpCatalog(params: {
  store: McpConnectionCatalogStore | undefined;
  served: McpCatalogStamp | undefined;
  list: () => Promise<unknown>;
}): Promise<unknown> {
  const { store, served } = params;
  if (!store || !served) return params.list();
  const stored = await loadEntry(store);
  if (stored && sameStamp(stored.stamp, served) && listedUnder(stored.result, served)) {
    return stored.result;
  }
  const result = await params.list();
  if (listedUnder(result, served)) {
    try {
      await withDeadline(
        Promise.resolve(store.store({ stamp: { ...served }, result })),
        STORE_TIMEOUT_MS,
      );
    } catch {
      // A store that cannot write costs the next process one `tools/list`, not this mount.
    }
  }
  return result;
}
