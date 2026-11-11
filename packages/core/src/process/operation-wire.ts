/**
 * What crosses between a server and the process that runs one of its
 * operations: one call on stdin, one answer — or a line per stream frame — on
 * stdout. Both sides parse with these schemas, so neither can drift alone.
 */
import { z } from 'zod';
import { ContractStreamErrorSchema } from '../contract/stream';

/**
 * The most one call may weigh. The server refuses to send more and the child
 * refuses to read more: a call is a request, and the bytes an operation works
 * on belong in a file it is told the path of.
 */
export const MAX_CALL_BYTES = 64 * 1024 * 1024;

/** The call one child process receives on stdin. */
export const OperationCallSchema = z.strictObject({
  operation: z.string().min(1),
  kind: z.enum(['unary', 'stream']),
  params: z.unknown().optional(),
  input: z.unknown().optional(),
});

/**
 * A refusal as it crosses the process boundary: the stream error envelope every
 * contract stream already speaks, plus the HTTP status the envelope leaves to
 * the response line — here there is no response line to carry it.
 */
export const OperationErrorSchema = ContractStreamErrorSchema.extend({
  status: z.number().int().optional(),
});

/** One line of a streamed answer: a contract stream frame whose error keeps its status. */
export const OperationFrameSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('data'), data: z.unknown() }),
  z.strictObject({ type: z.literal('error'), error: OperationErrorSchema }),
  z.strictObject({ type: z.literal('end') }),
]);

/** The single answer of a unary operation, one JSON document on stdout. */
export const OperationAnswerSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), data: z.unknown().optional() }),
  z.strictObject({ ok: z.literal(false), error: OperationErrorSchema }),
]);
