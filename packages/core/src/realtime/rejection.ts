import { z } from 'zod';
import { AppError } from '../contract/errors';
import { zodIssues } from '../internal/errors';
import type { RealtimeRejectDirection, RealtimeRejectedEvent } from './contract';

export function realtimeContractViolation(options: {
  event: string;
  direction: RealtimeRejectDirection;
  phase: 'arguments' | 'acknowledgement';
  reason: RealtimeRejectedEvent['reason'];
  fault: RealtimeRejectedEvent['fault'];
  cause?: unknown;
}): RealtimeRejectedEvent {
  const issues = options.cause instanceof z.ZodError ? zodIssues(options.cause) : undefined;
  const reason = options.reason.replaceAll('-', ' ');
  const error = new AppError(
    'REALTIME_CONTRACT_VIOLATION',
    `Realtime event "${options.event}" (${options.direction}, ${options.phase}): ${reason}`,
    500,
    {
      event: options.event,
      direction: options.direction,
      phase: options.phase,
      reason: options.reason,
      fault: options.fault,
      ...(issues !== undefined && { issues }),
    },
  );
  if (options.cause !== undefined) error.cause = options.cause;
  return { ...options, error };
}
