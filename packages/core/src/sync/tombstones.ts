/**
 * Deletes that win until acknowledged, and a full snapshot that cleans only what it may.
 *
 * A local delete is durable on the device as a tombstone and wins over any
 * remote row of the entity until the server acknowledges it. A tombstone the
 * server sent is different: a live row arriving later means the server changed
 * its mind — or the delete was a guess from an incomplete snapshot — and the
 * row comes back. After a complete full snapshot, a local row the server no
 * longer has is stale, unless the device still has work pending on it.
 */

/** Who deleted the entity: `local` wins until the server acknowledges it, `remote` yields to a later live row. */
export type TombstoneSource = 'local' | 'remote';

/** What to do with a live remote row, given the tombstone the device holds for it. */
export type RemoteRowDecision = 'apply' | 'skip' | 'resurrect';

/** Decide whether to apply, skip, or resurrect an incoming live remote row given its tombstone. */
export function decideRemoteRow(tombstone: TombstoneSource | null): RemoteRowDecision {
  if (tombstone === 'local') return 'skip';
  if (tombstone === 'remote') return 'resurrect';
  return 'apply';
}

/**
 * Whether a remote row whose parent may be gone is shown. A child of a parent
 * deleted in this same page is hidden; a child of a tombstoned parent is hidden
 * unless this page brought the parent back.
 */
export function dependentRowVisible(parent: {
  readonly tombstone: TombstoneSource | null;
  readonly deletedInPage: boolean;
  readonly resurrectedInPage: boolean;
}): boolean {
  if (parent.deletedInPage) return false;
  return parent.tombstone === null || parent.resurrectedInPage;
}

/** Local, server, and protected entity ID sets passed to `staleAfterFullSync`. */
export interface FullSyncSets {
  /** The ids the device holds. */
  readonly local: Iterable<string>;
  /**
   * The ids the completed snapshot named: the rows `apply` marked with its `snapshot` id,
   * kept with the rows. A set held in memory names only the pages of this process, and a
   * snapshot continued after a restart would make the earlier ones stale.
   */
  readonly server: ReadonlySet<string>;
  /** Ids the device still has work pending on; never stale. */
  readonly protectedIds?: ReadonlySet<string>;
}

/** Local ids the completed snapshot no longer has and nothing protects. */
export function staleAfterFullSync(sets: FullSyncSets): string[] {
  const protectedIds = sets.protectedIds ?? new Set<string>();
  return [...sets.local].filter((id) => !sets.server.has(id) && !protectedIds.has(id));
}

/**
 * Children whose parent is gone, after a paginated full snapshot. For a chain
 * (grandchildren of removed children), call it again with the surviving
 * children as `parents`.
 */
export function orphansOf<CHILD extends { id: string }>(
  children: readonly CHILD[],
  parents: { readonly ids: ReadonlySet<string>; readonly of: (child: CHILD) => string },
): string[] {
  return children
    .filter((child) => !parents.ids.has(parents.of(child)))
    .map((child) => child.id);
}
