import { z } from 'zod';
import type { AgentRuntimeStoreDriver } from './store-driver-contract';

/**
 * A driver member a store may lack, named as `store.capabilities` names it: `archive`
 * (`driver.archive`) or `historyRestore` (`driver.history.restore`).
 */
export const AgentStoreOptionalCapabilitySchema = z.enum(['archive', 'historyRestore']);
/** A driver member a store may lack: `archive` or `history.restore`. */
export type AgentStoreOptionalCapability = z.infer<typeof AgentStoreOptionalCapabilitySchema>;

/**
 * What the driver under a store implements beyond the required contract. Frozen on
 * `store.capabilities`, so a host and the conformance kit read the same answer the
 * store acts on.
 */
export const AgentRuntimeStoreCapabilitiesSchema = z.strictObject({
  /** `driver.archive`: spills and companion projections travel in an archive. */
  archive: z.boolean(),
  /** `driver.history.restore`: compacted history is restored as inactive rows. */
  historyRestore: z.boolean(),
  /** `driver.conversations`: `purgeConversation` exists. */
  purge: z.boolean(),
});
/** What the driver under a store implements beyond the required contract, as `store.capabilities` reports it. */
export type AgentRuntimeStoreCapabilities = z.infer<
  typeof AgentRuntimeStoreCapabilitiesSchema
>;

/**
 * Refusal of an operation that needs a driver member the store does not have. Thrown
 * before the operation writes, so the conversation stays as it was; a `TypeError`, so
 * code that already treats a malformed store input as one keeps doing so.
 */
export class AgentStoreUnsupportedCapabilityError extends TypeError {
  readonly capability: AgentStoreOptionalCapability;

  constructor(capability: AgentStoreOptionalCapability, need: string) {
    super(
      `The agent store driver does not implement ${capability === 'archive' ? 'archive' : 'history.restore'}: ${need}`,
    );
    this.name = 'AgentStoreUnsupportedCapabilityError';
    this.capability = capability;
  }
}

/** Read the driver's optional members once, refusing a half-implemented archive. */
export function driverCapabilities<T>(
  driver: AgentRuntimeStoreDriver<T>,
): Readonly<AgentRuntimeStoreCapabilities> {
  const archive = driver.archive;
  if (
    archive !== undefined &&
    (typeof archive.export !== 'function' || typeof archive.import !== 'function')
  )
    throw new TypeError('An agent store driver archive needs both export and import');
  if (driver.history.restore !== undefined && typeof driver.history.restore !== 'function')
    throw new TypeError('An agent store driver history.restore must be a function');
  return Object.freeze(
    AgentRuntimeStoreCapabilitiesSchema.parse({
      archive: archive !== undefined,
      historyRestore: driver.history.restore !== undefined,
      purge: driver.conversations !== undefined,
    }),
  );
}

/** What a source needs of the driver before anything is written: spills and compacted rows. */
export function assertSourceCapabilities<T>(
  driver: AgentRuntimeStoreDriver<T>,
  source: { spills: number; projections: number; compacted: number },
): void {
  if (!driver.archive && source.spills > 0)
    throw new AgentStoreUnsupportedCapabilityError('archive', 'the source carries spills');
  if (!driver.archive && source.projections > 0)
    throw new AgentStoreUnsupportedCapabilityError(
      'archive',
      'the source carries companion projections',
    );
  if (!driver.history.restore && source.compacted > 0)
    throw new AgentStoreUnsupportedCapabilityError(
      'historyRestore',
      'the source baseline carries compacted history',
    );
}
