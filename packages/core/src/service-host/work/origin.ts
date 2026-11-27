import { z } from 'zod';
import { ProcessInstanceSchema } from '../../internal/process-instance';
import { SystemdScopeSchema } from '../systemd-render-shared';
import { WorkLaunchError } from './errors';
import { type WorkRef, WorkRefSchema } from './owner';

/** Process ids are signed 32-bit integers. */
const MAX_PID = 2 ** 31 - 1;

/** The one variable a launched process and its descendants inherit; it names, it never proves. */
export const WORK_ORIGIN_ENV = 'STITCHKIT_WORK_ORIGIN';

/** The variable travels in every descendant's environment, so its value stays small. */
const MAX_WORK_ORIGIN_BYTES = 1024;

const WorkScopeUnitSchema = z
  .string()
  .max(255)
  .regex(/^[a-z][a-z0-9-]*-[A-Za-z0-9][A-Za-z0-9_.:-]*\.scope$/);

/**
 * The boundary work lives in: a transient systemd scope named by its manager and unit, or a
 * process root named by its pid and process instance.
 */
export const WorkBoundarySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('transient-scope'),
    manager: SystemdScopeSchema,
    unit: WorkScopeUnitSchema,
  }),
  z.strictObject({
    kind: z.literal('process-root'),
    root: z.strictObject({
      pid: z.number().int().positive().max(MAX_PID),
      instance: ProcessInstanceSchema,
    }),
  }),
]);
/** The boundary work lives in. */
export type WorkBoundary = z.infer<typeof WorkBoundarySchema>;

/** What `STITCHKIT_WORK_ORIGIN` holds: the work it names and the boundary that proves it. */
export const WorkOriginSchema = z.strictObject({
  v: z.literal(1),
  work: WorkRefSchema,
  boundary: WorkBoundarySchema,
});
/** The parsed value of `STITCHKIT_WORK_ORIGIN`. */
export type WorkOrigin = z.infer<typeof WorkOriginSchema>;

/** What a process root's variable holds before the root has measured itself. */
export function workOriginPrefix(work: WorkRef): { v: 1; work: WorkRef } {
  return { v: 1, work: WorkRefSchema.parse(work) };
}

/** The variable's text for one origin; refuses a value too large to travel in an environment. */
export function encodeWorkOrigin(origin: WorkOrigin): string {
  const text = JSON.stringify(WorkOriginSchema.parse(origin));
  if (Buffer.byteLength(text) > MAX_WORK_ORIGIN_BYTES)
    throw new WorkLaunchError(
      'origin-unreadable',
      `${WORK_ORIGIN_ENV} would exceed ${MAX_WORK_ORIGIN_BYTES} bytes`,
    );
  return text;
}

/**
 * Reads the claim a process inherited: `null` when the variable is absent, the parsed origin
 * when it is well formed. A value that does not parse, or one of another version, throws
 * `WorkLaunchError` with reason `origin-unreadable` — it is never read as "no origin". The claim
 * proves nothing by itself; `checkWorkMembership` asks the boundary.
 */
export function readWorkOrigin(
  env: Readonly<Record<string, string | undefined>> = process.env,
): WorkOrigin | null {
  const text = env[WORK_ORIGIN_ENV];
  if (text === undefined) return null;
  try {
    if (Buffer.byteLength(text) > MAX_WORK_ORIGIN_BYTES)
      throw new Error(`value exceeds ${MAX_WORK_ORIGIN_BYTES} bytes`);
    return WorkOriginSchema.parse(JSON.parse(text));
  } catch (cause) {
    throw new WorkLaunchError('origin-unreadable', `${WORK_ORIGIN_ENV} does not parse`, {
      cause,
    });
  }
}
