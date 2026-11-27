import { z } from 'zod';
import { SystemdScopeSchema } from '../systemd-render-shared';

/** The largest memory limit taken, in mebibytes: far beyond any host, still an exact integer. */
const MAX_MEMORY_MB = 2 ** 30;

/**
 * Resource limits of a transient scope. Each one becomes a property of the unit, so the
 * manager and the kernel enforce it on every process in the scope.
 */
export const WorkScopeLimitsSchema = z.strictObject({
  /** `MemoryMax=`: the hard memory ceiling, in mebibytes. */
  memoryMaxMb: z.number().int().positive().max(MAX_MEMORY_MB).optional(),
  /** `MemorySwapMax=`: the swap ceiling, in mebibytes; `0` forbids swap. */
  memorySwapMaxMb: z.number().int().nonnegative().max(MAX_MEMORY_MB).optional(),
  /** `CPUQuota=`: CPU time as a percentage of one CPU; above 100 spans several. */
  cpuQuotaPercent: z.number().int().positive().max(100_000).optional(),
  /** `CPUWeight=`: the share of CPU time among the units of one slice, 1 to 10000. */
  cpuWeight: z.number().int().min(1).max(10_000).optional(),
  /** `RuntimeMaxSec=`: the manager stops the scope once it has run this long. */
  runtimeMaxSeconds: z.number().int().positive().max(31_536_000).optional(),
});
/** Resource limits of a transient scope. */
export type WorkScopeLimits = z.input<typeof WorkScopeLimitsSchema>;

/** A slice named in full, in the characters systemd takes unescaped. */
const NamedSliceSchema = z
  .string()
  .max(255)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*\.slice$/);

export const WorkScopePlacementSchema = z.strictObject({
  kind: z.literal('transient-scope'),
  /** The manager that owns the scope: the system manager, or the caller's user manager. */
  manager: SystemdScopeSchema,
  /**
   * The slice the scope is placed in. `'caller'` keeps the caller's own slice, and so its
   * resource limits; anything else names a slice in full (`build.slice`).
   */
  slice: z.union([z.literal('caller'), NamedSliceSchema]),
  limits: WorkScopeLimitsSchema.optional(),
});
/** Work placed in a transient systemd scope: its manager, its slice and its limits. */
export type WorkScopePlacement = z.input<typeof WorkScopePlacementSchema>;

/**
 * Where work goes: a transient systemd scope, or a process root. The choice is always
 * written out — a host that cannot make the asked boundary refuses, it does not pick another.
 */
export const WorkPlacementSchema = z.discriminatedUnion('kind', [
  WorkScopePlacementSchema,
  z.strictObject({ kind: z.literal('process-root') }),
]);
/** Where work goes. */
export type WorkPlacement = z.input<typeof WorkPlacementSchema>;
