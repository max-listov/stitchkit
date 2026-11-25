/**
 * The CLI projects every failure code the Unix client transport emits.
 *
 * The codes have one list, beside the transport's error: the type the transport
 * throws with is derived from it and the CLI recognises a transport failure by it,
 * so a code added to the transport cannot fall through the projection unseen.
 */
import { expect, test } from 'bun:test';
import {
  UNIX_CLIENT_DELIVERY_STATES,
  UNIX_CLIENT_TRANSPORT_ERROR_CODES,
  UnixClientTransportError,
} from '../src/internal/unix-client-error';
import { projectCliUnixFailure } from '../src/tools/cli/unix-outcome';
import { toolResultFromError } from '../src/tools/execute-result';

test('every Unix transport code reaches the CLI as itself', () => {
  expect(UNIX_CLIENT_TRANSPORT_ERROR_CODES.length).toBeGreaterThan(0);
  for (const code of UNIX_CLIENT_TRANSPORT_ERROR_CODES) {
    const projected = projectCliUnixFailure(
      toolResultFromError(
        new UnixClientTransportError(code, `failed: ${code}`, 'response-received'),
      ),
    );
    expect(projected.code, code).toBe(code);
    expect(projected.details).toMatchObject({ delivery: 'response-received' });
  }
});

test('every Unix delivery state reaches the CLI as itself', () => {
  expect(UNIX_CLIENT_DELIVERY_STATES.length).toBeGreaterThan(0);
  for (const delivery of UNIX_CLIENT_DELIVERY_STATES) {
    const projected = projectCliUnixFailure(
      toolResultFromError(
        new UnixClientTransportError('UNIX_RESPONSE_ABORTED', 'failed', delivery),
      ),
    );
    expect(projected.details, delivery).toMatchObject({ delivery });
  }
});
