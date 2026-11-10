import type { OperationIdentity } from '../../server/types';

/**
 * Whether calling the operation again returns its answer without a new effect.
 *
 * The declared `readOnlyHint` decides in either direction; without one, `GET` is
 * the contract's own statement that the endpoint reads.
 */
export function isRepeatableRead(
  operation: Pick<OperationIdentity, 'method' | 'annotations'>,
): boolean {
  return operation.annotations?.readOnlyHint ?? operation.method === 'GET';
}
