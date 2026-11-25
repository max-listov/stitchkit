/**
 * Pending local edits stay on top of what the server sends, until it acknowledges them.
 *
 * A local edit is the newest accepted truth on the device until the server
 * confirms it. A page of remote rows may refresh the rest of a row, but must
 * not overwrite, even for a moment, a field a pending edit touched. The rule
 * the consuming apps pin: when the local row exists, its current value wins —
 * it already holds the edit — and the pending payload is used only when there
 * is no local row yet. Which fields an edit touches, and how a payload field
 * maps to a projection field, is the app's: `parse` says it.
 */

/** One pending update read from the outbox, oldest first. */
export interface PendingUpdate {
  readonly payload: unknown;
  readonly createdAt: string;
}

/** Entity-specific parser and merge rules mapping pending outbox payloads onto local row fields. */
export interface OverlaySpec<ROW extends { updatedAt: string }> {
  /**
   * What one pending payload touches: `values` for fields it sets, `protects`
   * for fields it changes without carrying their value (an edit whose result is
   * computed into another field). `undefined` when the payload is not an update
   * of this entity — it is skipped, never thrown.
   */
  parse(
    payload: unknown,
  ): { values: Partial<ROW>; protects?: readonly (keyof ROW)[] } | undefined;
  /**
   * The value kept from the current row for a touched field. Default: the
   * current row's value. Return `undefined` to keep nothing for that field.
   */
  keep?: { [K in keyof ROW]?: (current: ROW, pending: Partial<ROW>) => ROW[K] | undefined };
}

/** The fields that win over a remote row, and the `updatedAt` it carries. */
export type Overlay<ROW extends { updatedAt: string }> = Partial<ROW>;

/** Current local row and overlay specification passed to `deriveOverlay`. */
export interface OverlayInput<ROW extends { updatedAt: string }> {
  /** The entity's local row, or `null` when there is none yet. */
  readonly current: ROW | null;
  readonly spec: OverlaySpec<ROW>;
}

/** Derive the field overlay that protects unacknowledged local edits over incoming remote rows. */
export function deriveOverlay<ROW extends { updatedAt: string }>(
  pending: readonly PendingUpdate[],
  input: OverlayInput<ROW>,
): Overlay<ROW> {
  const { current, spec } = input;
  const values: Partial<ROW> = {};
  const touched = new Set<keyof ROW>();
  let updatedAt: string | undefined;
  for (const update of pending) {
    const parsed = spec.parse(update.payload);
    if (!parsed) continue;
    // A key present with `undefined` is no value: it must not erase the remote one.
    for (const key in parsed.values) {
      if (!Object.hasOwn(parsed.values, key) || parsed.values[key] === undefined) continue;
      values[key] = parsed.values[key];
      touched.add(key);
    }
    for (const key of parsed.protects ?? []) touched.add(key);
    updatedAt = update.createdAt;
  }
  if (updatedAt === undefined) return {};
  if (!current) return { ...values, updatedAt };
  const accepted: Partial<ROW> = {};
  accepted.updatedAt = current.updatedAt;
  for (const key of touched) {
    if (key === 'updatedAt') continue;
    const keep = spec.keep?.[key];
    const value = keep ? keep(current, values) : current[key];
    if (value !== undefined) accepted[key] = value;
  }
  return accepted;
}

/** A remote row with the pending fields on top. */
export function applyOverlay<ROW extends { updatedAt: string }>(
  remote: ROW,
  overlay: Overlay<ROW>,
): ROW {
  return { ...remote, ...overlay };
}
