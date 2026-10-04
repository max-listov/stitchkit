import { AppError, isRetryableStatus, STITCH_ERROR_STATUS } from '../../contract/errors';
import {
  ConnectionAuthorizationRequiredError,
  ConnectionBudgetExceededError,
  ConnectionRequestError,
  ConnectionResponseTooLargeError,
  ConnectionTimeoutError,
  ConnectionUrlError,
} from './errors';

/** Only fixed diagnostic fields cross the tool boundary; the runner retains the raw cause. */
export function connectionToolError(error: unknown): AppError | undefined {
  if (error instanceof ConnectionTimeoutError) {
    const message = 'Connection deadline exceeded';
    return new AppError(
      'CONNECTION_TIMEOUT',
      message,
      STITCH_ERROR_STATUS.CONNECTION_TIMEOUT,
      {
        message,
        reason: 'deadline-exceeded',
        operation: error.operation,
        phase: error.phase,
        timeoutMs: error.timeoutMs,
        observedReadBytes: error.observedReadBytes,
      },
      'Check the connection deadline and verify any write outcome before retrying.',
      undefined,
      false,
    );
  }
  if (error instanceof ConnectionResponseTooLargeError) {
    const message = 'Connection response exceeds the byte limit';
    return new AppError(
      'CONNECTION_RESPONSE_TOO_LARGE',
      message,
      STITCH_ERROR_STATUS.CONNECTION_RESPONSE_TOO_LARGE,
      {
        message,
        reason: 'response-too-large',
        operation: error.operation,
        phase: error.phase,
        maxResponseBytes: error.maxBytes,
        observedReadBytes: error.observedReadBytes,
      },
      'Narrow the response or increase the limit for this operation phase.',
      undefined,
      false,
    );
  }
  if (error instanceof ConnectionAuthorizationRequiredError) {
    const message = 'Authorization required';
    return new AppError(
      'UNAUTHORIZED',
      message,
      STITCH_ERROR_STATUS.UNAUTHORIZED,
      {
        message,
        reason: 'authorization-required',
        operation: error.operation,
        phase: error.phase,
      },
      'Obtain a new credential before retrying.',
      undefined,
      false,
    );
  }
  if (error instanceof ConnectionRequestError) {
    const forbidden = error.status === 403;
    const code = forbidden ? 'FORBIDDEN' : 'CONNECTION_REQUEST_FAILED';
    const message = forbidden ? 'Connection access denied' : 'Connection request failed';
    return new AppError(
      code,
      message,
      STITCH_ERROR_STATUS[code],
      {
        message,
        reason: forbidden ? 'permission-denied' : 'upstream-request-failed',
        operation: error.operation,
        phase: error.phase,
        upstreamStatus: error.status,
      },
      forbidden
        ? 'Check the credential permissions.'
        : 'Check the upstream service and verify any write outcome before retrying.',
      undefined,
      !forbidden && isRetryableStatus(error.status),
    );
  }
  if (error instanceof ConnectionUrlError) {
    return new AppError(
      'BAD_REQUEST',
      'Connection URL refused',
      STITCH_ERROR_STATUS.BAD_REQUEST,
      { message: 'Connection URL refused', reason: 'url-rejected' },
      'Check the connection URL and its allowed hosts.',
      undefined,
      false,
    );
  }
  if (error instanceof ConnectionBudgetExceededError) {
    return new AppError(
      'BAD_REQUEST',
      'Connection mount budget exceeded',
      STITCH_ERROR_STATUS.BAD_REQUEST,
      {
        message: 'Connection mount budget exceeded',
        reason: 'mount-budget-exceeded',
        limit: error.limit,
        actual: error.actual,
      },
      'Narrow the mounted tool surface or increase its mount budget.',
      undefined,
      false,
    );
  }
  return undefined;
}
