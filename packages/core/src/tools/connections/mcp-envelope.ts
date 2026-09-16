/**
 * What a discovered MCP tool's answer is, per transport.
 *
 * `tools/call` returns an envelope — `{ content: [...], structuredContent? }` —
 * and an agent mount needs exactly that: the parts are what a model is shown.
 * The CLI transport is different in kind, because the handler's value is what
 * gets printed, piped and aggregated. Handed the envelope, `--count-by status`
 * groups the *parts* and answers `no record carries the field "status" —
 * available: text, type`, and `--json` emits the answer as a JSON string nested
 * inside `content[0].text`, so every consumer unwraps before anything works.
 *
 * So the CLI unwraps, and only the CLI. The order is the server's own order of
 * preference: `structuredContent` is the answer when the server sent one; a lone
 * text part is the answer when it parses as JSON, and its text when it does not.
 * Anything else — several parts, an image, audio — is passed through whole,
 * because picking one part out of many would be inventing an answer.
 */

import { AppError } from '../../contract/errors';
import { safeJsonParse } from '../../internal/safe-json';
import { isRecord } from '../../internal/typed';

export function unwrapMcpResult(result: unknown): unknown {
  if (!isRecord(result)) return result;
  if (result.structuredContent !== undefined) return result.structuredContent;
  if (!Array.isArray(result.content)) return result;
  const only = result.content.length === 1 ? result.content[0] : undefined;
  if (!isRecord(only) || only.type !== 'text' || typeof only.text !== 'string') return result;
  try {
    return safeJsonParse(only.text);
  } catch {
    // Not JSON: the text itself is the answer. A server is free to answer in
    // prose, and turning that into a parse error would lose it.
    return only.text;
  }
}

/**
 * The class a relayed failure carries when the server sent no structured body.
 *
 * Not `INTERNAL_SERVER_ERROR`: nothing of ours broke. The honest statement is
 * that the call failed upstream and we cannot say more than the server did.
 */
export const UPSTREAM_TOOL_ERROR = 'UPSTREAM_TOOL_ERROR';

/**
 * Turn a failed `CallToolResult` into the error the caller can act on.
 *
 * The line this replaces threw a one-sentence `Error` and discarded the result,
 * which cost three things at once: the code (so `exitCodes` had nothing to map
 * and every remote failure exited `1`), the message the operator needed, and the
 * error's own class — a plain `Error` is an *unexpected* error to the runner, so
 * it printed a code frame of the framework bundle before the JSON failure and
 * was then scrubbed to a bare `INTERNAL_SERVER_ERROR`.
 *
 * A structured `{ error, details }` body is the remote contract's own refusal
 * and is relayed as one. Anything else keeps the framework's sentence and
 * carries what the server did send — reporting less than we have is not caution.
 * The status is 502 either way: whatever the code says, the failure happened
 * upstream, and a consumer re-serving it over HTTP should say so.
 */
export function mcpToolFailure(toolName: string, result: unknown): AppError {
  const payload = unwrapMcpResult(result);
  if (isRecord(payload) && typeof payload.error === 'string') {
    const details = isRecord(payload.details) ? payload.details : undefined;
    const message = typeof details?.message === 'string' ? details.message : payload.error;
    return new AppError(payload.error, message, 502, details);
  }
  return new AppError(
    UPSTREAM_TOOL_ERROR,
    `External MCP tool "${toolName}" returned an error`,
    502,
    payload === undefined ? undefined : { upstream: payload },
  );
}
