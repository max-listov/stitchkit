/**
 * Raw-route conveniences. A `RawRoute` is full `Request → Response` control (file
 * streaming, webhooks, public SDK endpoints) — it deliberately skips the contract
 * pipeline. These three helpers give back the boilerplate that pipeline does for
 * free, reusing the **same** error envelope and trace id, so raw routes and
 * contract routes stay consistent. They are conveniences, not a second pipeline:
 * no auth, no schema gate beyond `parseBody`.
 */
import type { ZodType } from 'zod';
import { normalizeError } from '../contract/normalize';
import { concatChunks, readBoundedChunks } from '../internal/bounded-body';
import { assertPositiveSafeInteger } from '../internal/positive-integer';
import { getTraceId } from '../observability/context';

/** A JSON response for `data`; `204 No Content` when `data` is null/undefined. */
export function respondJson(data: unknown): Response {
  if (data === null || data === undefined) return new Response(null, { status: 204 });
  return Response.json(data);
}

/**
 * Turn any thrown value into the framework's error envelope + HTTP status — the
 * identical shape (`{ error: { code, message, details?, hint? } }`) a contract
 * route returns, via `normalizeError`. Stamps `x-request-id` with the current
 * trace id when called inside a request context.
 */
export function errorResponse(error: unknown): Response {
  const appErr = normalizeError(error);
  const res = Response.json(appErr.toJSON(), { status: appErr.status });
  const traceId = getTraceId();
  if (traceId) res.headers.set('x-request-id', traceId);
  return res;
}

/**
 * Parse and validate a JSON request body. Returns the typed value, or `null` for
 * a non-JSON, schema-invalid or too large body (never throws — the caller decides the
 * error response). The body is read up to `options.maxBytes` (1 MiB by default, a positive
 * safe integer — anything else throws, since a silent no-limit is worse) and not a byte further. The error helpers (`badRequest`, …) **throw**, so raise one inside a
 * `try` and render it in the `catch` with `errorResponse(err)`:
 *
 * ```ts
 * try {
 *   const body = await parseBody(req, Schema)
 *   if (!body) throw badRequest('invalid body')
 *   return respondJson(await handle(body))
 * } catch (err) {
 *   return errorResponse(err)
 * }
 * ```
 */
export async function parseBody<T>(
  req: Request,
  schema: ZodType<T>,
  options: { maxBytes?: number } = {},
): Promise<T | null> {
  assertPositiveSafeInteger('maxBytes', options.maxBytes);
  const raw = await readJson(req, options.maxBytes ?? DEFAULT_PARSE_BODY_BYTES);
  if (raw === null) return null;
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

const DEFAULT_PARSE_BODY_BYTES = 1024 * 1024;

/** The JSON of a request up to `maxBytes`; `null` for anything else, an abort included. */
async function readJson(req: Request, maxBytes: number): Promise<unknown> {
  try {
    const result = await readBoundedChunks(req.body, { maxBytes, signal: req.signal });
    if (result.kind === 'over-limit') return null;
    return JSON.parse(new TextDecoder().decode(concatChunks(result.chunks, result.total)));
  } catch {
    return null;
  }
}
