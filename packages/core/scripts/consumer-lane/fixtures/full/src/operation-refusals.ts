/**
 * Declared refusals from the installed package (ADR 0330): `refuses` accepts the factories of an
 * error vocabulary, and `client.op.refusal(error)` narrows `code` and types `details` through the
 * packed `.d.ts` — the type a consumer compiles against, not the source. The fixture's typecheck
 * (`include: ["src"]`) reads it; the runtime half of the rule is proven in the package tests.
 */
import { ApiError, createClient } from 'stitchkit';
import { defineContract, defineErrors } from 'stitchkit/contract';
import { z } from 'zod';

const { errors } = defineErrors({
  NOT_IDLE: { status: 409 },
  MIN_AWAKE: { status: 409, details: z.object({ minimum: z.number().int() }) },
  PROFILE_UNAVAILABLE: { status: 503 },
});

const sessions = defineContract(
  { prefix: 'session' },
  {
    sleep: {
      method: 'POST',
      path: '/sleep',
      desc: 'Put a session to sleep',
      output: z.object({ ok: z.boolean() }),
      refuses: [errors.NOT_IDLE, errors.MIN_AWAKE],
    },
  },
);

const client = createClient(sessions, { baseUrl: 'http://127.0.0.1:9' });
const refusal = client.sleep.refusal(
  new ApiError('MIN_AWAKE', { status: 409, details: { minimum: 2 } }),
);

function minimumOf(): number | undefined {
  if (refusal?.code !== 'MIN_AWAKE') return undefined;
  // Typed by the code's schema through the packed declarations.
  const minimum: number = refusal.details.minimum;
  return minimum;
}

if (refusal !== undefined) {
  // @ts-expect-error `sleep` never declared PROFILE_UNAVAILABLE.
  void (refusal.code === 'PROFILE_UNAVAILABLE');
}

if (minimumOf() !== 2)
  throw new Error('the packed refusal() did not read the declared refusal');
if (client.sleep.refusal(new ApiError('PROFILE_UNAVAILABLE', { status: 503 })) !== undefined) {
  throw new Error('the packed refusal() read a code the operation did not declare');
}
