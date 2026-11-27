import { z } from 'zod';

const WorkLaunchErrorReasonSchema = z.enum([
  'origin-unreadable',
  'platform-unsupported',
  'systemd-unavailable',
  'systemd-too-old',
  'manager-unreachable',
  'user-manager-unreachable',
  'slice-unresolvable',
  'unit-exists',
  'scope-refused',
  'root-unobservable',
  'root-unobserved',
  'membership-unavailable',
  'stop-failed',
]);
/** Why work could not be placed in, read from or stopped as its boundary. */
export type WorkLaunchErrorReason = z.infer<typeof WorkLaunchErrorReasonSchema>;

/**
 * Thrown when a boundary cannot be made, read or stopped. `reason` names the refusal and
 * `cause` holds what the host answered; nothing is launched outside the boundary that was asked for.
 */
export class WorkLaunchError extends Error {
  readonly reason: WorkLaunchErrorReason;

  constructor(reason: WorkLaunchErrorReason, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'WorkLaunchError';
    this.reason = WorkLaunchErrorReasonSchema.parse(reason);
  }
}
